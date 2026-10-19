import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  lintTaxonomyFile,
  lintTaxonomyText,
  type Taxonomy,
} from "../scripts/lib/taxonomy.ts";
import { validateLabels } from "../scripts/lib/validate.ts";
import { type Deps, main } from "../scripts/validate-labels.ts";

const script = join(import.meta.dir, "..", "scripts", "validate-labels.ts");
const fixture = join(
  import.meta.dir,
  "fixtures",
  "validator",
  "label-taxonomy.yaml",
);
const taxonomy = lintTaxonomyFile(fixture).taxonomy as Taxonomy;
const base = ["feature", "small", "app", "area:api"];
const check = (...labels: string[]) => validateLabels(labels, taxonomy);
const errors = (...labels: string[]) => check(...labels).errors.join("\n");

test("the fixture taxonomy passes its own lint", () => {
  expect(lintTaxonomyFile(fixture).problems).toEqual([]);
});

describe("a complete label set", () => {
  test("is valid with no warning", () => {
    const result = check(...base, "agent:backend", "domain:billing");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("sorts each label into its family", () => {
    expect(
      check(...base, "agent:backend", "has-migration", "routine").parsed,
    ).toEqual({
      types: ["feature"],
      groups: { size: ["small"], repo: ["app"], urgency: ["routine"] },
      categories: { area: ["area:api"], agent: ["agent:backend"] },
      flags: ["has-migration"],
      unknown: [],
    });
  });

  test("a repeated label counts once", () => {
    expect(check(...base, "small", "area:api").valid).toBe(true);
  });
});

describe("single-select groups and types", () => {
  test("two labels of one group are rejected (two repository labels)", () => {
    expect(errors(...base, "website")).toContain(
      "more than one label of group 'repo': app, website",
    );
  });

  test("two sizes are rejected", () => {
    expect(errors(...base, "large")).toContain(
      "more than one label of group 'size'",
    );
  });

  test("a required group with no label is rejected", () => {
    const result = check("feature", "small", "area:api");
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "no label of required group 'repo' (one of: app, website, tooling)",
    );
  });

  test("an optional group may be absent, but not doubled", () => {
    expect(check(...base).valid).toBe(true);
    expect(errors(...base, "routine", "pressing")).toContain("group 'urgency'");
  });

  test("no type is rejected", () => {
    expect(errors("small", "app", "area:api")).toContain(
      "no type label (one of: feature, bug, chore, docs)",
    );
  });

  test("two types are rejected", () => {
    expect(errors(...base, "bug")).toContain(
      "more than one type label: feature, bug",
    );
  });
});

describe("unknown labels", () => {
  test("a label the taxonomy does not define is rejected", () => {
    const result = check(...base, "platform", "agent:astronaut");
    expect(result.valid).toBe(false);
    expect(result.parsed.unknown).toEqual(["platform", "agent:astronaut"]);
    expect(result.errors.join("\n")).toContain(
      "unknown labels: platform, agent:astronaut",
    );
  });

  test("a status is not a label", () => {
    expect(errors(...base, "in-progress")).toContain("unknown label");
  });
});

describe("label names are checked as written", () => {
  test("whitespace around a name is rejected, not trimmed", () => {
    const result = check(...base, " area:api ");
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "whitespace around ' area:api ' (write the exact name: 'area:api')",
    );
    expect(result.labels).not.toContain(" area:api ");
  });

  test("an empty label is rejected, not dropped", () => {
    expect(errors(...base, "")).toContain("an empty label");
  });
});

describe("family ids that are Object.prototype names", () => {
  const prototypeNamed = lintTaxonomyText(`version: 1
types: [{id: bug}]
statuses: [{id: todo}]
groups:
  - id: __proto__
    required: true
    labels: [{id: small}]
  - id: constructor
    labels: [{id: app}]
categories:
  - id: toString
    prefix: "area:"
    labels: [{id: api}]
`);

  test("still lint, and are validated like any other id", () => {
    expect(prototypeNamed.problems).toEqual([]);
    const tax = prototypeNamed.taxonomy as Taxonomy;
    expect(validateLabels(["bug"], tax).errors).toContain(
      "no label of required group '__proto__' (one of: small)",
    );
    const full = validateLabels(["bug", "small", "app", "area:api"], tax);
    expect(full.errors).toEqual([]);
    expect(Object.entries(full.parsed.groups)).toEqual([
      ["__proto__", ["small"]],
      ["constructor", ["app"]],
    ]);
    expect(Object.hasOwn(full.parsed.categories, "toString")).toBe(true);
  });
});

describe("open categories", () => {
  test("any slug matching the pattern is accepted, the seeded one included", () => {
    for (const label of ["pattern:missing-await", "pattern:off-by-one"])
      expect(check("bug", "small", "app", "area:api", label).valid).toBe(true);
  });

  test("a slug that does not match the pattern is rejected", () => {
    for (const label of ["pattern:Off_By_One", "pattern:"])
      expect(errors("bug", "small", "app", "area:api", label)).toContain(
        "is not a valid 'pattern:' label: its slug must match",
      );
  });

  test("an unanchored pattern still matches the whole slug", () => {
    const unanchored = lintTaxonomyText(
      'types:\n  - id: bug\nstatuses:\n  - id: todo\ncategories:\n  - id: pattern\n    prefix: "pattern:"\n    open: "[a-z]+"\n',
    ).taxonomy as Taxonomy;
    expect(validateLabels(["bug", "pattern:flaky"], unanchored).valid).toBe(
      true,
    );
    for (const label of ["pattern:Foo bar", "pattern:flaky2"])
      expect(validateLabels(["bug", label], unanchored).errors).toEqual([
        `'${label}' is not a valid 'pattern:' label: its slug must match ^(?:[a-z]+)$`,
      ]);
  });

  test("its requires still applies: a pattern label needs the bug type", () => {
    expect(errors(...base, "pattern:off-by-one")).toContain(
      "pattern:off-by-one requires 'bug' beside it (category 'pattern')",
    );
  });
});

describe("a facet without its umbrella", () => {
  test("a stage facet without its domain label is rejected", () => {
    expect(errors(...base, "stage:planning")).toContain(
      "stage:planning requires 'domain:delivery' beside it",
    );
  });

  test("a stage facet beside its domain label is valid, one or several", () => {
    expect(check(...base, "domain:delivery", "stage:planning").valid).toBe(
      true,
    );
    expect(
      check(...base, "domain:delivery", "stage:planning", "stage:review").valid,
    ).toBe(true);
  });

  test("the umbrella alone is a complete labelling", () => {
    expect(check(...base, "domain:delivery").valid).toBe(true);
  });

  test("an unknown stage is rejected", () => {
    expect(errors(...base, "domain:delivery", "stage:bogus")).toContain(
      "unknown label: stage:bogus",
    );
  });

  test("a stakeholder facet without the hitl flag is rejected", () => {
    expect(errors(...base, "hitl:legal")).toContain(
      "hitl:legal requires 'hitl' beside it",
    );
  });

  test("the hitl flag without any stakeholder facet is rejected", () => {
    expect(errors(...base, "hitl")).toContain(
      "'hitl' requires at least one label of category 'hitl-stakeholder' (hitl:…)",
    );
  });

  test("the hitl flag with one or several facets is valid", () => {
    expect(check(...base, "hitl", "hitl:legal").valid).toBe(true);
    expect(check(...base, "hitl", "hitl:legal", "hitl:product").valid).toBe(
      true,
    );
  });

  test("a bogus stakeholder facet is rejected", () => {
    expect(errors(...base, "hitl", "hitl:bogus")).toContain(
      "unknown label: hitl:bogus",
    );
  });

  test("a flag that requires another flag is rejected alone, valid beside it", () => {
    expect(errors(...base, "operator-hands")).toContain(
      "'operator-hands' requires 'manual-ops' beside it",
    );
    expect(check(...base, "operator-hands", "manual-ops").valid).toBe(true);
    expect(check(...base, "manual-ops").valid).toBe(true);
  });
});

describe("the epic flag", () => {
  test("is a flag, not a type: an epic keeps its real type", () => {
    for (const type of taxonomy.types)
      expect(check(type, "small", "app", "area:api", "epic").valid).toBe(true);
    expect(errors("small", "app", "epic")).toContain("no type label");
  });

  test("composes with pattern labels on a defect epic", () => {
    expect(
      check("bug", "large", "app", "area:api", "epic", "pattern:off-by-one")
        .valid,
    ).toBe(true);
  });
});

describe("warnings", () => {
  test("more labels of a category than its max warn, without failing", () => {
    const result = check(
      ...base,
      "agent:backend",
      "agent:frontend",
      "agent:devops",
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "3 labels of category 'agent', more than its recommended 2",
    ]);
  });

  test("a recommended category with no label warns, without failing", () => {
    const result = check("feature", "small", "app");
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "no label of category 'area' (labels beginning 'area:'); consider adding one",
    ]);
  });
});

const run = (args: string[], options: { stdin?: string } = {}) =>
  Bun.spawnSync([process.execPath, script, ...args], {
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
  });

describe("the command line", () => {
  test("exit 0 on a valid set, 3 on an invalid one", () => {
    const valid = run(["--taxonomy", fixture, ...base]);
    expectSpawnExit(valid, 0);
    expect(valid.stdout.toString()).toContain("VALID (4 labels)");
    const invalid = run(["--taxonomy", fixture, ...base, "website"]);
    expectSpawnExit(invalid, 3);
    expect(invalid.stdout.toString()).toContain(
      "ERROR: more than one label of group 'repo'",
    );
  });

  test("warnings print and keep exit 0", () => {
    const out = run(["--taxonomy", fixture, "feature", "small", "app"]);
    expectSpawnExit(out, 0);
    expect(out.stdout.toString()).toContain("WARNING: no label of category");
  });

  test("--json prints valid, labels, errors, warnings and parsed", () => {
    const out = run(["--json", "--taxonomy", fixture, ...base, "pattern:x"]);
    expectSpawnExit(out, 3);
    const result = JSON.parse(out.stdout.toString());
    expect(Object.keys(result)).toEqual([
      "valid",
      "labels",
      "errors",
      "warnings",
      "parsed",
    ]);
    expect(result.valid).toBe(false);
    expect(result.labels).toEqual([...base, "pattern:x"]);
    expect(result.parsed.categories.pattern).toEqual(["pattern:x"]);
  });

  test("the labels may come as a JSON array on stdin", () => {
    const out = run(["--taxonomy", fixture], {
      stdin: JSON.stringify(base),
    });
    expectSpawnExit(out, 0);
    for (const stdin of ["", "not json", '{"labels": ["bug"]}', "[]"])
      expectSpawnExit(run(["--taxonomy", fixture], { stdin }), 2);
  });

  test("an unknown option or a --taxonomy without a path is a usage error", () => {
    expectSpawnExit(run(["--taxonomy", fixture, "--strict", "bug"]), 2);
    expectSpawnExit(run(["--taxonomy"]), 2);
  });

  test("a missing taxonomy, or one failing its lint, is exit 1", () => {
    const missing = run(["--taxonomy", join(tmpdir(), "absent.yaml"), "bug"]);
    expectSpawnExit(missing, 1);
    expect(missing.stderr.toString()).toContain("label taxonomy not found");
    const broken = run([
      "--taxonomy",
      join(
        import.meta.dir,
        "fixtures",
        "taxonomy",
        "bad",
        "category-requires-unknown.yaml",
      ),
      "feature",
    ]);
    expectSpawnExit(broken, 1);
    expect(broken.stderr.toString()).toContain("fails its lint");
  });

  test("without --taxonomy it reads issue_tracker.taxonomy, relative to the repository root", () => {
    const repo = mkdtempSync(join(tmpdir(), "validate-labels-"));
    mkdirSync(join(repo, ".config"));
    mkdirSync(join(repo, "docs"));
    copyFileSync(fixture, join(repo, "docs", "labels.yaml"));
    writeFileSync(
      join(repo, ".config", "jig.yaml"),
      "issue_tracker:\n  taxonomy: docs/labels.yaml\n",
    );
    const env = {
      ...process.env,
      JIG_CONSUMER_ROOT: repo,
      JIG_OVERLAY: join(repo, ".config", "jig.yaml"),
    };
    const configured = Bun.spawnSync([process.execPath, script, ...base], {
      cwd: repo,
      env,
      stdin: "ignore",
    });
    expectSpawnExit(configured, 0);
    writeFileSync(join(repo, ".config", "jig.yaml"), "issue_tracker: {}\n");
    const fallback = Bun.spawnSync([process.execPath, script, ...base], {
      cwd: repo,
      env,
      stdin: "ignore",
    });
    expectSpawnExit(fallback, 1);
    expect(fallback.stderr.toString()).toContain(
      join(repo, "label-taxonomy.yaml"),
    );
  });
});

describe("--check-tracker", () => {
  const capture = async (argv: string[], deps: Deps) => {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (line: string) => lines.push(line);
    console.error = (line: string) => lines.push(line);
    try {
      return { code: await main(argv, deps), out: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  const tracker = (names: string[]): Deps => ({
    openTracker: () => ({
      listLabels: async () => names.map((name) => ({ name, group: null })),
    }),
    readStdin: async () => "",
  });

  test("passes when every label names exactly one tracker label", async () => {
    const { code } = await capture(
      ["--check-tracker", "--taxonomy", fixture, ...base],
      tracker(["feature", "small", "app", "area:api", "bug"]),
    );
    expect(code).toBe(0);
  });

  test("fails with exit 3, naming each label the tracker lacks, case included", async () => {
    const { code, out } = await capture(
      ["--check-tracker", "--json", "--taxonomy", fixture, ...base],
      tracker(["Feature", "small"]),
    );
    expect(code).toBe(3);
    const result = JSON.parse(out);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      "not in the tracker: feature, app, area:api (create them there, or fix the name; names match exactly, case included)",
    ]);
  });

  test("fails with exit 3, naming each label the tracker has more than once", async () => {
    const { code, out } = await capture(
      ["--check-tracker", "--json", "--taxonomy", fixture, ...base],
      tracker(["feature", "small", "app", "app", "area:api", "area:api"]),
    );
    expect(code).toBe(3);
    expect(JSON.parse(out).errors).toEqual([
      "more than one tracker label named: app, area:api (rename or merge them in the tracker so each name is one label)",
    ]);
  });

  test("a tracker that cannot be read is exit 1, not a verdict", async () => {
    const { code, out } = await capture(
      ["--check-tracker", "--taxonomy", fixture, ...base],
      {
        openTracker: () => ({
          listLabels: async () => {
            throw new Error("unauthorized");
          },
        }),
        readStdin: async () => "",
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("could not be read: unauthorized");
  });

  test("without the flag the tracker is never opened", async () => {
    const { code } = await capture(["--taxonomy", fixture, ...base], {
      openTracker: () => {
        throw new Error("opened");
      },
      readStdin: async () => "",
    });
    expect(code).toBe(0);
  });
});
