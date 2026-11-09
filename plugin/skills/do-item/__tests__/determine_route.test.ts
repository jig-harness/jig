/**
 * determine_route.ts: the route's base effort from the work type, each
 * raise and its order, the cap, the strictest row for `unknown`, the
 * translation to a runtime's names, and every configuration the loading
 * rules refuse. The complexity tiers and the models per tier are in
 * determine_route-tiers.test.ts.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  CatalogFieldError,
  catalogFacts,
  defaultRaiseSizes,
  deriveRoute,
  type RouteFacts,
} from "../scripts/determine_route.ts";
import {
  DEFAULT_EFFORTS,
  parseRouting,
  RoutingError,
  undeclaredRaiseLabels,
} from "../scripts/lib/routing.ts";
import { DEFAULT_TYPES, parseWorkTypes } from "../scripts/lib/work-types.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "determine_route.ts");

const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  agent: "general-purpose",
  type: "bug",
  labels: [],
  catalog: { flags: [], reviews: [] },
  hitl: "hitl",
  knownSizes: ["xs", "small", "medium"],
  batchSizes: ["xs", "small", "medium"],
  runtime: "claude-code",
  ...over,
});

/** A complete depth-table row, for a type outside the default list. */
const CHORE_ROW = {
  pre_scouts: [],
  test_first: "none",
  review_tiers: [1],
  review_skip_lines: 50,
  change_note: "not_required",
  batchable: "yes",
  autonomy: "full",
  pr_body_sections: ["what_changed"],
};

/** A repository whose types are `bug` and `chore`. */
const WITH_CHORE = {
  issue_tracker: { types: { chore: ["chore"], bug: ["bug", "type:bug"] } },
  do_item: { work_types: { chore: CHORE_ROW } },
};

const rules = (config: Record<string, unknown> = {}) =>
  parseRouting(config, parseWorkTypes(config));

const route = (
  over: Partial<RouteFacts> = {},
  config: Record<string, unknown> = { routing: {} },
) => deriveRoute(facts(over), rules(config));

describe("the base", () => {
  it.each([...DEFAULT_TYPES])("takes %s's default effort", (type) => {
    const r = route({ type });
    expect(r.effort).toBe(DEFAULT_EFFORTS[type]);
    expect(r.reasons).toContain(`effort: ${r.effort} (type ${type})`);
  });

  it("reads a type's row from routing.types, field by field", () => {
    const r = route(
      { type: "task" },
      { routing: { types: { task: { effort: "high" } } } },
    );
    expect({ tier: r.tier, effort: r.effort }).toEqual({
      tier: "simple",
      effort: "high",
    });
  });

  it("gives unknown the highest tier and the highest effort any row names", () => {
    const r = route({ type: "unknown" });
    expect({ tier: r.tier, effort: r.effort }).toEqual({
      tier: "complex",
      effort: "high",
    });
    expect(r.reasons).toContain(
      "tier: complex (type unknown: the strictest row)",
    );
  });

  it("does not let an override that lowers a type lower unknown", () => {
    const r = route(
      { type: "unknown" },
      { routing: { types: { spike: { tier: "simple", effort: "low" } } } },
    );
    expect({ tier: r.tier, effort: r.effort }).toEqual({
      tier: "complex",
      effort: "high",
    });
  });

  it("raises unknown above the defaults when a row names a higher effort", () => {
    const r = route(
      { type: "unknown" },
      { routing: { types: { bug: { effort: "max" } } } },
    );
    expect(r.effort).toBe("max");
  });

  it("gives a type the repository added the strictest row while routing is undeclared", () => {
    const r = deriveRoute(facts({ type: "chore" }), rules(WITH_CHORE));
    expect(r.declared).toBe(false);
    expect(r.tier).toBe("complex");
    expect(r.reasons).toContain(
      "tier: complex (type chore has no routing row: the strictest row)",
    );
  });
});

describe("the raises", () => {
  it("raises on a flag the catalog declares", () => {
    const r = route({
      labels: ["has-migration"],
      catalog: { flags: ["has-migration"], reviews: [] },
    });
    expect(r.effort).toBe("high");
    expect(r.reasons).toContain(
      "effort: high (flag has-migration raised medium)",
    );
  });

  it("raises on a flag routing.raise.flags lists, and not on a catalog flag it leaves out", () => {
    const config = { routing: { raise: { flags: ["security"] } } };
    const catalog = { flags: ["has-migration"], reviews: [] };
    expect(route({ labels: ["Security"], catalog }, config).effort).toBe(
      "high",
    );
    expect(route({ labels: ["has-migration"], catalog }, config).effort).toBe(
      "medium",
    );
  });

  it("raises on an area's mandatory review", () => {
    const r = route({
      catalog: {
        flags: [],
        reviews: [{ area: "payments", skills: ["security-review"] }],
      },
    });
    expect(r.effort).toBe("high");
    expect(r.reasons).toContain(
      "effort: high (area payments's mandatory review (security-review) raised medium)",
    );
  });

  it("does not raise on a mandatory review when routing.raise.reviews is false", () => {
    const r = route(
      {
        catalog: {
          flags: [],
          reviews: [{ area: "payments", skills: ["sec"] }],
        },
      },
      { routing: { raise: { reviews: false } } },
    );
    expect(r.effort).toBe("medium");
  });

  it("raises on a size too large to batch", () => {
    const r = route({
      labels: ["xl"],
      knownSizes: ["xs", "small", "medium", "large", "xl"],
    });
    expect(r.effort).toBe("high");
    expect(r.reasons).toContain("effort: high (size xl raised medium)");
  });

  it("never raises on a batchable size", () => {
    expect(route({ labels: ["medium"] }).effort).toBe("medium");
  });

  it("reads the item's size facet, not its labels, where it has one", () => {
    const sized = { knownSizes: ["xs", "small", "medium", "large", "xl"] };
    expect(route({ ...sized, labels: ["xl"], sizes: [] }).effort).toBe(
      "medium",
    );
    expect(route({ ...sized, sizes: ["xl"] }).reasons).toContain(
      "effort: high (size xl raised medium)",
    );
  });

  it("raises on a size routing.raise.sizes lists", () => {
    const config = { routing: { raise: { sizes: ["medium"] } } };
    expect(route({ labels: ["medium"] }, config).effort).toBe("high");
  });

  it("raises on the human-in-the-loop label and its facets", () => {
    expect(route({ labels: ["hitl"] }).effort).toBe("high");
    expect(route({ labels: ["hitl:legal"] }).effort).toBe("high");
    expect(
      route({ labels: ["needs-person"], hitl: "needs-person" }).effort,
    ).toBe("high");
  });

  it("counts the human-in-the-loop label once where the catalog also lists it as a flag", () => {
    const r = route({
      labels: ["hitl"],
      catalog: { flags: ["hitl"], reviews: [] },
    });
    expect(r.effort).toBe("high");
    expect(r.reasons).toContain(
      "effort: high (human-in-the-loop label hitl raised medium)",
    );
  });

  it("moves the effort one step per class, however many labels of the class", () => {
    const r = route({
      labels: ["security", "has-migration"],
      catalog: { flags: ["security", "has-migration"], reviews: [] },
    });
    expect(r.effort).toBe("high");
  });

  it("applies the classes in order: flag, review, size, human-in-the-loop", () => {
    const r = route({
      type: "task",
      labels: ["hitl", "large", "security"],
      catalog: {
        flags: ["security"],
        reviews: [{ area: "auth", skills: ["sec"] }],
      },
    });
    expect(r.reasons.filter((x) => x.startsWith("effort:"))).toEqual([
      "effort: low (type task)",
      "effort: medium (flag security raised low)",
      "effort: high (area auth's mandatory review (sec) raised medium)",
      "effort: max (size large raised high)",
      "effort: max (human-in-the-loop label hitl: already the highest effort)",
    ]);
  });

  it("caps the effort at max and never moves the tier", () => {
    const r = route({
      type: "feature",
      labels: ["hitl", "security"],
      catalog: { flags: ["security"], reviews: [{ area: "a", skills: ["s"] }] },
    });
    expect(r.effort).toBe("max");
    expect(r.tier).toBe("standard");
  });

  it("raises on flags and reviews alike when a declared catalog cannot be read", () => {
    const r = route({ catalog: null });
    expect(r.effort).toBe("max");
    expect(r.reasons).toContain(
      "effort: high (the catalog cannot be read, so its flags are taken to apply raised medium)",
    );
  });
});

describe("defaultRaiseSizes", () => {
  it("is the known sizes outside the batchable ones", () => {
    expect(
      defaultRaiseSizes(["xs", "small", "large", "XL"], ["xs", "small"]),
    ).toEqual(["large", "XL"]);
  });

  it("is [large] where every known size is batchable", () => {
    expect(defaultRaiseSizes(["xs", "small"], ["xs", "small"])).toEqual([
      "large",
    ]);
  });

  it("is empty where large itself is batchable", () => {
    expect(defaultRaiseSizes(["small", "large"], ["small", "Large"])).toEqual(
      [],
    );
  });

  it("never raises a batchable large", () => {
    const r = route({
      labels: ["large"],
      knownSizes: ["small", "large"],
      batchSizes: ["small", "large"],
    });
    expect(r.effort).toBe("medium");
  });
});

describe("catalogFacts", () => {
  const catalog = parseCatalog({
    areas: {
      api: { paths: ["api/**"], tracker: { flags: ["has-migration"] } },
      payments: {
        paths: ["pay/**"],
        impliedBy: ["api"],
        review: { skills: ["security-review"] },
      },
      docs: { paths: ["docs/**"], review: { skills: [] } },
    },
  });

  it("collects every area's flags", () => {
    expect(catalogFacts(catalog, [], {}).flags).toEqual(["has-migration"]);
  });

  it("reads the mandatory reviews of the seeded areas and their impliedBy closure", () => {
    expect(
      catalogFacts(catalog, ["Area:API"], { "area:api": "api" }).reviews,
    ).toEqual([{ area: "payments", skills: ["security-review"] }]);
  });

  it("does not count an area whose review names no skill", () => {
    expect(catalogFacts(catalog, ["docs"], { docs: "docs" }).reviews).toEqual(
      [],
    );
  });

  it.each([
    ["an impliedBy that is not a list", { impliedBy: "api" }, "impliedBy"],
    ["an impliedBy written but empty (null)", { impliedBy: null }, "impliedBy"],
    ["a review that is not a mapping", { review: "security-review" }, "review"],
    ["a review written but empty (null)", { review: null }, "review"],
    [
      "a review whose skills is not a list",
      { review: { skills: "security-review" } },
      "review",
    ],
  ])("refuses %s rather than dropping its obligation", (_, fields, field) => {
    const malformed = parseCatalog({
      areas: {
        api: { paths: ["api/**"] },
        pay: { paths: ["p/**"], ...fields },
      },
    });
    expect(() => catalogFacts(malformed, ["api"], { api: "api" })).toThrow(
      CatalogFieldError,
    );
    expect(() => catalogFacts(malformed, [], {})).toThrow(`areas.pay.${field}`);
  });

  it("refuses an impliedBy naming an id no area has rather than dropping its review", () => {
    const misspelled = parseCatalog({
      areas: {
        api: { paths: ["api/**"] },
        payments: {
          paths: ["pay/**"],
          impliedBy: ["apix"],
          review: { skills: ["security-review"] },
        },
      },
    });
    expect(() => catalogFacts(misspelled, ["api"], { api: "api" })).toThrow(
      "areas.payments.impliedBy names apix",
    );
  });

  it("refuses a label mapped to an id no area has rather than dropping its review", () => {
    expect(() =>
      catalogFacts(catalog, ["area:pay"], { "area:pay": "paymnets" }),
    ).toThrow(
      "do_item.agents.codearea_areas maps area:pay to paymnets, which no area of the catalog is",
    );
  });

  it("ignores a misspelled mapping for a label the item does not carry", () => {
    expect(
      catalogFacts(catalog, ["area:api"], {
        "area:api": "api",
        "area:pay": "paymnets",
      }).reviews,
    ).toEqual([{ area: "payments", skills: ["security-review"] }]);
  });
});

describe("the translation", () => {
  it("maps the tier to the runtime's family alias", () => {
    expect(route({ type: "spike" }).model).toBe("opus");
    expect(route({ type: "bug" }).model).toBe("sonnet");
  });

  it("runs Codex on Sol for a complex item and Terra for a standard one with no routing.models", () => {
    const complex = route({ runtime: "codex", type: "spike" });
    expect(complex.model).toBe("sol");
    expect(complex.runtime_model).toBe("gpt-6.1-sol");
    expect(complex.reasons).toContain(
      "model: gpt-6.1-sol for codex (the model sol names)",
    );
    const standard = route({ runtime: "codex", type: "bug" });
    expect(standard.model).toBe("terra");
    expect(standard.runtime_model).toBe("gpt-5.6-terra");
  });

  it("gives Claude Code the family alias itself", () => {
    const r = route({ type: "spike" });
    expect(r.runtime_model).toBe("opus");
  });

  it("reads a runtime's row from routing.models", () => {
    const config = {
      routing: {
        models: { "my-agent": { simple: "a", standard: "b", complex: "c" } },
      },
    };
    const r = route({ runtime: "my-agent" }, config);
    expect(r.model).toBe("b");
    expect(r.runtime_model).toBe("b");
    expect(r.reasons).toContain("model: b (routing.models.my-agent.standard)");
  });

  it("proposes no model for a runtime with no row, and says so", () => {
    const r = route({ runtime: "other" });
    expect(r.model).toBeNull();
    expect(r.runtime_model).toBeNull();
    expect(r.reasons).toContain("model: none (no model for other)");
  });

  it("proposes no model when no runtime is identified", () => {
    const r = route({ runtime: null });
    expect(r.model).toBeNull();
    expect(r.reasons).toContain("model: none (no runtime identified)");
  });

  it("spells the effort as the runtime does", () => {
    const config = {
      routing: { efforts: { "claude-code": { max: "xhigh" } } },
    };
    const r = route({ labels: ["hitl", "large"], type: "feature" }, config);
    expect(r.effort).toBe("max");
    expect(r.runtime_effort).toBe("xhigh");
  });

  it("records every field as the rules' answer", () => {
    expect(route().fields).toEqual({
      tier: { requested: null, source: "rules" },
      effort: { requested: null, source: "rules" },
      model: { requested: null, source: "rules" },
    });
  });

  it("says whether the repository declares routing", () => {
    expect(route({}, {}).declared).toBe(false);
    expect(route({}, { routing: {} }).declared).toBe(true);
    expect(route({}, { routing: null }).declared).toBe(false);
  });
});

describe("the loading rules", () => {
  const refuses = (routing: unknown, field: string, config = {}) =>
    expect(() => rules({ ...config, routing })).toThrow(
      expect.objectContaining({ message: expect.stringContaining(field) }),
    );

  it.each([
    [[], "routing must be a mapping"],
    [{ tiers: {} }, "routing.tiers is not a field of routing"],
    [{ types: { unknown: { tier: "standard" } } }, "routing.types.unknown"],
    [
      { types: { epic: { tier: "standard" } } },
      "routing.types.epic: epic is not a type",
    ],
    [
      { types: { bug: { tier: "judgment" } } },
      "routing.types.bug.tier must be one of simple, standard, complex",
    ],
    [{ types: { bug: { tier: "scout" } } }, "routing.types.bug.tier"],
    [
      { types: { bug: { effort: "xhigh" } } },
      "routing.types.bug.effort must be one of low, medium, high, max",
    ],
    [
      { types: { bug: { model: "opus" } } },
      "routing.types.bug.model is not a field",
    ],
    [{ raise: { flags: "security" } }, "routing.raise.flags must be a list"],
    [
      { raise: { sizes: ["large", "large"] } },
      "routing.raise.sizes must be a list of distinct",
    ],
    [
      { raise: { reviews: "yes" } },
      "routing.raise.reviews must be true or false",
    ],
    [{ raise: { labels: [] } }, "routing.raise.labels is not a field"],
    [{ models: { custom: { standard: "a" } } }, "missing: simple, complex"],
    [
      { models: { "claude-code": { standard: "sonnet 4" } } },
      "routing.models.claude-code.standard must be a family alias",
    ],
    [{ models: { "claude-code": { complex: "a,b" } } }, "one word"],
    [{ models: { Claude: { standard: "a" } } }, "a runtime name is lowercase"],
    [
      { models: { "claude-code": { tier3: "opus" } } },
      "routing.models.claude-code.tier3 is not a field",
    ],
    [
      { complex_flags: "has-migration" },
      "routing.complex_flags must be a list",
    ],
    [
      { efforts: { codex: { extreme: "x" } } },
      "routing.efforts.codex.extreme is not a field",
    ],
    [{ efforts: { codex: { max: "x=y" } } }, "routing.efforts.codex.max"],
  ])("refuses %j", (routing, field) => refuses(routing, field));

  it("refuses a declared section that leaves an added type without a complete row", () => {
    refuses(
      { types: { chore: { tier: "standard" } } },
      "routing.types.chore: chore is not a default type",
      WITH_CHORE,
    );
  });

  it("accepts an added type with a complete row", () => {
    const r = rules({
      ...WITH_CHORE,
      routing: { types: { chore: { tier: "simple", effort: "low" } } },
    });
    expect(r.rows.chore).toEqual({ tier: "simple", effort: "low" });
  });

  it("throws a RoutingError", () => {
    expect(() => rules({ routing: { types: { bug: { tier: "x" } } } })).toThrow(
      RoutingError,
    );
  });

  it("lists the declared raise labels a taxonomy does not declare", () => {
    const r = rules({
      routing: { raise: { flags: ["security", "pii"], sizes: ["xl"] } },
    });
    expect(undeclaredRaiseLabels(r, (l) => l === "security")).toEqual([
      { field: "routing.raise.flags", label: "pii" },
      { field: "routing.raise.sizes", label: "xl" },
    ]);
  });

  it("never checks a default list against the taxonomy", () => {
    expect(undeclaredRaiseLabels(rules({ routing: {} }), () => false)).toEqual(
      [],
    );
  });
});

describe("determine_route.ts", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** The environment with no harness variables, plus `extra`. */
  const env = (extra: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (
        v !== undefined &&
        k !== "CLAUDECODE" &&
        !k.startsWith("CODEX_") &&
        !k.startsWith("ORCA_") &&
        !k.startsWith("CONDUCTOR_") &&
        k !== "HERDR_ENV"
      )
        out[k] = v;
    return { ...out, ...extra };
  };

  /** Run the script in a scratch repository with `files` written into it. */
  const run = (
    files: Record<string, string>,
    input: string,
    extra: Record<string, string> = { CLAUDECODE: "1" },
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "determine-route-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    const r = spawnSync(process.execPath, [SCRIPT, "-"], {
      cwd: dir,
      input,
      encoding: "utf8",
      env: env({
        ...extra,
        JIG_OVERLAY: join(dir, "jig.yaml"),
        JIG_CONSUMER_ROOT: dir,
      }),
    });
    return { ...r, exitCode: r.status };
  };

  /** A bug, its type in its type facet as `get_issue.ts` prints it. */
  const issue = (labels: string[], title = "x") =>
    JSON.stringify({ type: "bug", labels, title, nativeType: null });

  it("prints a flagged bug's route, complex by its flag and raised by the catalog's", () => {
    const r = run(
      {
        "jig.yaml": "routing: {}\ndrive:\n  change_areas_catalog: areas.yaml\n",
        "areas.yaml":
          "areas:\n  db:\n    paths: ['db/**']\n    tracker:\n      flags: [has-migration]\n",
      },
      issue(["bug", "has-migration"]),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      agent: "general-purpose",
      type: "bug",
      tier: "complex",
      effort: "high",
      model: "opus",
      runtime: "claude-code",
      declared: true,
    });
  });

  it("raises as if the catalog applied when an area's review is malformed", () => {
    const r = run(
      {
        "jig.yaml": "routing: {}\ndrive:\n  change_areas_catalog: areas.yaml\n",
        "areas.yaml":
          "areas:\n  db:\n    paths: ['db/**']\n    review: {skills: security-review}\n",
      },
      issue(["bug"]),
    );
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("areas.db.review");
    expect(JSON.parse(r.stdout).effort).toBe("max");
  });

  it("routes a repository whose batchable sizes the default batching points do not price", () => {
    const r = run(
      {
        "jig.yaml":
          "routing: {}\nissue_tracker:\n  labels:\n    batch_sizes: [small, large]\n",
      },
      issue(["bug", "large"]),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).effort).toBe("medium");
  });

  it("reads the size vocabulary from work_batch.sizes", () => {
    const r = run(
      {
        "jig.yaml": "routing: {}\nwork_batch:\n  sizes: [small, medium, xl]\n",
      },
      issue(["bug", "xl"]),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).reasons).toContain(
      "effort: high (size xl raised medium)",
    );
  });

  /** A taxonomy whose size group is the five sizes, and a type `bug`. */
  const SIZED_TAXONOMY =
    "version: 1\ntypes:\n  - id: bug\nstatuses:\n  - id: todo\ngroups:\n  - id: size\n    labels:\n      - id: xs\n      - id: small\n      - id: medium\n      - id: large\n      - id: xl\n";

  /** A bug with `size` in its size facet and `labels` beside it. */
  const sized = (size: string | null, labels: string[] = []) =>
    JSON.stringify({ type: "bug", size, labels, title: "x", nativeType: null });

  it("raises on the size facet's value, a taxonomy size beyond the batchable ones", () => {
    const r = run(
      { "jig.yaml": "routing: {}\n", "label-taxonomy.yaml": SIZED_TAXONOMY },
      sized("xl"),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).reasons).toContain(
      "effort: high (size xl raised medium)",
    );
  });

  it("reads routing.raise.sizes as size values", () => {
    const r = run(
      {
        "jig.yaml": "routing:\n  raise:\n    sizes: [medium]\n",
        "label-taxonomy.yaml": SIZED_TAXONOMY,
      },
      sized("medium"),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).reasons).toContain(
      "effort: high (size medium raised medium)",
    );
  });

  it("reads the batchable sizes as the labels of size values kept under a prefix", () => {
    const r = run(
      {
        "jig.yaml":
          "routing: {}\nissue_tracker:\n  labels:\n    batch_sizes: ['size:xs', 'size:small', 'size:medium']\n  facets:\n    size: { store: label, prefix: 'size:' }\n",
        "label-taxonomy.yaml": SIZED_TAXONOMY,
      },
      sized("medium", ["size:medium"]),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).effort).toBe("medium");
  });

  it("never reads a size label beside an unset size facet", () => {
    const r = run(
      { "jig.yaml": "routing: {}\n", "label-taxonomy.yaml": SIZED_TAXONOMY },
      sized(null, ["xl"]),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).effort).toBe("medium");
  });

  it("proposes no model where no runtime is identified", () => {
    const r = run({ "jig.yaml": "{}\n" }, issue(["bug"]), {});
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      model: null,
      declared: false,
    });
  });

  it("refuses a routing section the loading rules refuse, naming the file", () => {
    const r = run(
      { "jig.yaml": "routing:\n  types:\n    bug: { tier: judgment }\n" },
      issue(["bug"]),
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("routing.types.bug.tier");
    expect(r.stderr).toContain("jig.yaml");
  });

  it("refuses a raise label the label taxonomy does not declare", () => {
    const r = run(
      {
        "jig.yaml": "routing:\n  raise:\n    flags: [pii]\n",
        "label-taxonomy.yaml":
          "version: 1\ntypes:\n  - id: bug\nstatuses:\n  - id: todo\ngroups:\n  - id: size\n    labels:\n      - id: large\n",
      },
      issue(["bug"]),
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("routing.raise.flags names pii");
  });

  it("refuses input that is not an issue as a usage error", () => {
    for (const input of ["not json", '{"labels":"bug"}']) {
      const r = run({ "jig.yaml": "{}\n" }, input);
      expectSpawnExit(r, 2);
      expect(r.stderr).not.toBe("");
    }
  });
});
