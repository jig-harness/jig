/**
 * Profiles as targets: the shipped file parses against the shipped criteria,
 * agrees with the profiles page, and turns a record's scores into gaps.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadModules, parseModule } from "../scripts/lib/criteria.ts";
import {
  gaps,
  loadProfiles,
  parseProfiles,
  targetsFor,
} from "../scripts/lib/profiles.ts";
import { checkProfile, parseRecord } from "../scripts/lib/record.ts";

const modules = loadModules();
const profiles = loadProfiles(modules);
const README = join(import.meta.dir, "../../../../profiles/README.md");

describe("the shipped profiles", () => {
  test("cover every module in the adoption order, and name modules that have criteria", () => {
    expect([...profiles.order].sort()).toEqual(
      modules.map((m) => m.module).sort(),
    );
    expect([...profiles.profiles.keys()]).toEqual([
      "solo-lite",
      "team-standard",
      "regulated-strict",
    ]);
  });

  test("start the order where the brownfield ladder starts", () => {
    expect(profiles.order.slice(0, 4)).toEqual(["M1", "M2", "M0", "M4"]);
  });

  test("are the ones the profiles page names, and the page links the file", () => {
    const page = readFileSync(README, "utf8");
    for (const p of profiles.profiles.values())
      expect(page).toContain(`## ${p.name}`);
    expect(page).toContain("plugin/skills/audit/profiles.yaml");
  });

  test("never aim lower than the profile before them", () => {
    const rank = { lite: 0, standard: 1, strict: 2 } as const;
    const [solo, team, strict] = [...profiles.profiles.values()];
    for (const [lower, higher] of [
      [solo, team],
      [team, strict],
    ] as const)
      for (const [m, level] of lower?.targets ?? []) {
        const above = higher?.targets.get(m);
        expect([m, above !== undefined && rank[above] >= rank[level]]).toEqual([
          m,
          true,
        ]);
      }
  });
});

describe("parsing", () => {
  const two = ["M0", "M1"];
  test("refuses an unknown level, an unknown module and an incomplete order", () => {
    const head = "version: 1\nprofiles:\n  p:\n    name: P\n";
    expect(() =>
      parseProfiles(
        `${head}    targets: { M0: high }\norder: [M0, M1]\n`,
        "f",
        two,
      ),
    ).toThrow("a level is lite, standard, strict");
    expect(() =>
      parseProfiles(
        `${head}    targets: { M7: lite }\norder: [M0, M1]\n`,
        "f",
        two,
      ),
    ).toThrow("M7, which has no criteria");
    expect(() =>
      parseProfiles(
        `${head}    targets: { M0: lite }\norder: [M0]\n`,
        "f",
        two,
      ),
    ).toThrow("order must list every module once");
  });
});

describe("gaps", () => {
  const m = (module: string) =>
    parseModule(
      `module: ${module}\nname: x\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }\n  - { id: b, level: standard, requires: mechanical, statement: B., observe: [b] }\n`,
      `${module}-x.yaml`,
    );
  const mods = [m("M0"), m("M1"), m("M2")];
  const p = parseProfiles(
    "version: 1\nprofiles:\n  p:\n    name: P\n    targets: { M1: standard, M0: lite }\n    conditional:\n      M2: { level: lite, when: it applies }\norder: [M1, M0, M2]\n",
    "f",
    ["M0", "M1", "M2"],
  ).profiles.get("p");
  if (!p) throw new Error("no profile");
  const scores = new Map([
    ["M0/a", "convention"],
    ["M0/b", "absent"],
    ["M1/a", "mechanical"],
    ["M1/b", "convention"],
    ["M2/a", "expected-absent"],
    ["M2/b", "expected-absent"],
  ] as const);

  test("name the criteria between attained and target, in adoption order", () => {
    const result = gaps(mods, scores, targetsFor(p), ["M1", "M0", "M2"]);
    expect(
      result.map((g) => [
        g.module.module,
        g.target,
        g.missing.map((c) => c.key),
      ]),
    ).toEqual([
      ["M1", "standard", ["M1/b"]],
      ["M0", "lite", []],
      ["M2", null, []],
    ]);
  });

  test("a conditional target applies only when the record says so, and never to a module that does not apply", () => {
    expect(targetsFor(p, ["M2"]).get("M2")).toBe("lite");
    const [, , m2] = gaps(mods, scores, targetsFor(p, ["M2"]), [
      "M1",
      "M0",
      "M2",
    ]);
    expect([m2?.attained, m2?.target]).toEqual(["n/a", null]);
  });
});

test("a record's profile and conditions must be the shipped profile's", () => {
  const record = (extra: string) =>
    parseRecord(
      `version: 1\nplugin_version: 0.16.0\ndate: "2026-10-13"\ncommit: abc\n${extra}criteria: {}\n`,
      "r.yaml",
    );
  expect(
    checkProfile(
      record("profile: team-standard\nprofile_conditions: [M12]\n"),
      profiles,
    ),
  ).toEqual([]);
  expect(
    checkProfile(
      record("profile: solo-lite\nheading_to: team-standard\n"),
      profiles,
    ),
  ).toEqual([]);
  // A condition only the heading-to profile makes conditional is the team's to state.
  expect(
    checkProfile(
      record(
        "profile: solo-lite\nheading_to: team-standard\nprofile_conditions: [M3]\n",
      ),
      profiles,
    ),
  ).toEqual([]);
  expect(
    checkProfile(
      record(
        "profile: solo-lite\nheading_to: team-standard\nprofile_conditions: [M8]\n",
      ),
      profiles,
    ),
  ).toEqual([
    "profile_conditions: neither Solo/Lite nor Team/Standard has a conditional target for M8",
  ]);
  expect(checkProfile(record("heading_to: big\n"), profiles)[0]).toContain(
    "heading_to: big is not one of",
  );
  expect(checkProfile(record("profile: enterprise\n"), profiles)[0]).toContain(
    "enterprise is not one of",
  );
  expect(
    checkProfile(
      record("profile: solo-lite\nprofile_conditions: [M12]\n"),
      profiles,
    )[0],
  ).toContain("no conditional target for M12");
});
