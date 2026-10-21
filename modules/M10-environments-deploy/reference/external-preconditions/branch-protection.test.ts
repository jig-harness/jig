import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { branchProtection } from "./branch-protection.ts";
import {
  parseRegistry,
  PreconditionError,
  type Precondition,
} from "./registry.ts";
const registry = parseRegistry(
  readFileSync(new URL("fixtures/registry.yaml", import.meta.url), "utf8"),
);
const entry = registry.preconditions[0] as Precondition;
const fixture = JSON.parse(
  readFileSync(new URL("fixtures/protection.json", import.meta.url), "utf8"),
)[entry.id];
const check = branchProtection(() => {
  throw new PreconditionError("offline checks must not call gh");
});
const observe = (input = fixture, expected = entry.expected) =>
  check({ ...entry, expected }, input);

describe("branch protection", () => {
  test("separate PR bypass and safety rules permit bot writes", async () =>
    expect((await observe()).status).toBe("pass"));
  test("PR-only bypass cannot advance a bot-written pointer", async () => {
    const input = structuredClone(fixture);
    input.rulesets[0].bypass_actors[0].bypass_mode = "pull_request";
    expect((await observe(input)).status).toBe("fail");
  });
  test("absent bypass fails; withheld bypass is unknown", async () => {
    const absent = structuredClone(fixture);
    absent.rulesets[0].bypass_actors = [];
    expect((await observe(absent)).status).toBe("fail");
    delete absent.rulesets[0].bypass_actors;
    expect((await observe(absent)).status).toBe("unknown");
  });
  test("bypass on every safety rule fails protection for the writer", async () => {
    const input = structuredClone(fixture);
    input.rulesets[1].bypass_actors = input.rulesets[0].bypass_actors;
    expect((await observe(input)).status).toBe("fail");
  });
  test("a second ruleset's blocker is not bypassed by the first", async () => {
    const input = structuredClone(fixture);
    input.rules.push({ ruleset_id: 2, type: "required_signatures" });
    expect((await observe(input)).status).toBe("fail");
  });
  test("classic PR allowance is required independently of ruleset bypass", async () => {
    const input = structuredClone(fixture);
    input.classic = {
      required_pull_request_reviews: { required_approving_review_count: 0 },
    };
    expect((await observe(input)).status).toBe("fail");
    input.classic.required_pull_request_reviews.bypass_pull_request_allowances =
      { apps: [{ id: 42, slug: "verification-bot" }] };
    expect((await observe(input)).status).toBe("pass");
  });
  test("missing branch and denied classic read are distinct unknowns", async () => {
    for (const classic of ["unreadable", "missing"]) {
      const result = await observe({ ...fixture, classic });
      expect(result.status).toBe("unknown");
      expect(result.reasons.join()).toContain(
        classic === "unreadable" ? "denied" : "missing",
      );
    }
  });
  test("unprotected branch has absent controls, rather than denied access", async () => {
    const result = await observe({ classic: null, rules: [], rulesets: [] });
    expect(result.status).toBe("fail");
    expect(result.reasons.join()).toContain("absent");
  });
  test("disabled rulesets cannot satisfy controls", async () => {
    const input = structuredClone(fixture);
    input.rulesets[1].enforcement = "disabled";
    expect((await observe(input)).status).toBe("fail");
  });
  test("required checks and conversation resolution combine classic and rulesets", async () => {
    const input = structuredClone(fixture);
    input.rules.push({
      ruleset_id: 1,
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "gates" }] },
    });
    input.rules[0].parameters.required_review_thread_resolution = true;
    expect(
      (
        await observe(input, {
          required_checks: ["gates"],
          conversation_resolution: true,
        })
      ).status,
    ).toBe("pass");
    expect(
      (await observe(input, { required_checks: ["missing"] })).status,
    ).toBe("fail");
  });
  test("unknown expected fields and malformed fixtures fail closed", async () => {
    expect(() => observe(fixture, { writer: { app_id: -1 } })).toThrow();
    expect(() => observe(fixture, { pull_request: true })).toThrow();
    expect(() =>
      observe({ classic: null, rules: [null], rulesets: [] }),
    ).toThrow();
  });
  test("live read failures propagate as errors rather than absent controls", () => {
    const denied = branchProtection(() => ({
      ok: false,
      stdout: "",
      stderr: "HTTP 403 access denied",
    }));
    expect(() => denied(entry, undefined)).toThrow("403");
    const malformed = branchProtection(() => ({
      ok: true,
      stdout: "{}",
      stderr: "",
    }));
    expect(() => malformed(entry, undefined)).toThrow("pages");
  });
  test("malformed successful classic response is unknown, never absent", () => {
    const malformedClassic = branchProtection((args) => ({
      ok: true,
      stdout: args[0]?.endsWith("/protection") ? "null" : "[[]]",
      stderr: "",
    }));
    expect(() => malformedClassic(entry, undefined)).toThrow(
      "classic protection did not read as an object",
    );
  });
  test("live malformed enforcement cannot hide a blocking rule", () => {
    const malformed = branchProtection((args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.endsWith("/protection"))
        return {
          ok: false,
          stdout: "",
          stderr: "HTTP 404 Branch not protected",
        };
      if (path.includes("/rules/branches/"))
        return {
          ok: true,
          stdout: JSON.stringify([[{ ruleset_id: 1, type: "pull_request" }]]),
          stderr: "",
        };
      return {
        ok: true,
        stdout: JSON.stringify({
          id: 1,
          enforcement: "malformed",
          bypass_actors: [],
        }),
        stderr: "",
      };
    });
    expect(() =>
      malformed(
        {
          ...entry,
          expected: { pull_requests: false, writer: { app_id: 42 } },
        },
        undefined,
      ),
    ).toThrow();
  });
  test("live metadata identity and bypass shape failures cannot pass", () => {
    const actor = {
      actor_type: "Integration",
      actor_id: 42,
      bypass_mode: "always",
    };
    const valid = { id: 1, enforcement: "active", bypass_actors: [actor] };
    for (const metadata of [
      { ...valid, id: 2 },
      { id: 1, bypass_actors: [actor] },
      {
        ...valid,
        bypass_actors: [
          ...valid.bypass_actors,
          { ...actor, bypass_mode: "malformed" },
        ],
      },
      {
        ...valid,
        bypass_actors: [...valid.bypass_actors, { ...actor, actor_id: null }],
      },
      {
        ...valid,
        bypass_actors: [...valid.bypass_actors, { ...actor, actor_type: null }],
      },
    ]) {
      const malformed = branchProtection((args) => {
        const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
        if (path.endsWith("/protection"))
          return {
            ok: false,
            stdout: "",
            stderr: "HTTP 404 Branch not protected",
          };
        if (path.includes("/rules/branches/"))
          return {
            ok: true,
            stdout: JSON.stringify([[{ ruleset_id: 1, type: "pull_request" }]]),
            stderr: "",
          };
        return { ok: true, stdout: JSON.stringify(metadata), stderr: "" };
      });
      expect(() =>
        malformed(
          { ...entry, expected: { writer: { app_id: 42 } } },
          undefined,
        ),
      ).toThrow();
    }
  });
  test("offline observations meet the live response checks", () => {
    const variants: ((input: typeof fixture) => void)[] = [
      (input) => delete input.rulesets[1].enforcement,
      (input) => (input.rulesets[1].enforcement = "malformed"),
      (input) =>
        (input.rulesets[1].bypass_actors = [
          { actor_type: "Robot", actor_id: 7, bypass_mode: "pull_request" },
        ]),
      (input) =>
        (input.rulesets[1].bypass_actors = [
          { actor_type: "Integration", actor_id: 42, bypass_mode: ["always"] },
        ]),
      (input) =>
        (input.rulesets[1].bypass_actors = [
          { actor_type: "Integration", actor_id: [42], bypass_mode: "always" },
        ]),
    ];
    for (const mutate of variants) {
      const input = structuredClone(fixture);
      mutate(input);
      expect(() => observe(input)).toThrow();
    }
  });
});
