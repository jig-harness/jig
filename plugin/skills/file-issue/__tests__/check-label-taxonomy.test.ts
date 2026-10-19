import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { lintTaxonomyText } from "../scripts/lib/taxonomy.ts";

const script = join(
  import.meta.dir,
  "..",
  "scripts",
  "check-label-taxonomy.ts",
);
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "taxonomy", name);
const lint = (path: string, env: Record<string, string> = {}) =>
  Bun.spawnSync([process.execPath, script, path].filter(Boolean), {
    env: { ...process.env, ...env },
  });

// Each bad fixture breaks exactly one invariant: it fails with one problem,
// and that problem is the one the fixture is named for.
const cases: [string, number, string][] = [
  ["bad/duplicate-id.yaml", 1, "duplicate label id 'has-migration'"],
  ["bad/duplicate-types-key.yaml", 1, "duplicate top-level key"],
  ["bad/empty-statuses.yaml", 1, "'statuses:' is empty"],
  ["bad/flag-duplicate-fires.yaml", 1, "duplicate 'fires:' field"],
  ["bad/flag-empty-list-fires.yaml", 1, "declares no 'fires:'"],
  ["bad/flag-missing-fires.yaml", 1, "declares no 'fires:'"],
  ["bad/flag-missing-scope.yaml", 1, "declares no 'scope:'"],
  ["bad/flag-bad-scope.yaml", 1, "has scope 'anywhere'"],
  ["bad/flag-missing-apply-when.yaml", 1, "declares no 'apply_when:'"],
  ["bad/flag-empty-do-not-apply-when.yaml", 1, "empty 'do_not_apply_when:'"],
  ["bad/flag-requires-unknown.yaml", 1, "requires 'legal'"],
  ["bad/flag-requires-self.yaml", 1, "requires itself"],
  ["bad/unknown-key.yaml", 1, "unknown top-level key"],
  ["bad/group-label-duplicates-type.yaml", 1, "duplicate label id 'bug'"],
  ["bad/duplicate-family-id.yaml", 1, "duplicate family id 'size'"],
  ["bad/group-empty-labels.yaml", 1, "group 'size' declares no 'labels:'"],
  [
    "bad/group-required-not-boolean.yaml",
    1,
    "group 'size' has a 'required:' that is not true or false",
  ],
  [
    "bad/category-missing-prefix.yaml",
    1,
    "category 'area' declares no 'prefix:'",
  ],
  [
    "bad/category-prefix-overlap.yaml",
    1,
    "prefix 'area:', which begins category 'sub-area'",
  ],
  [
    "bad/category-no-labels-no-open.yaml",
    1,
    "category 'area' declares neither 'labels:' nor 'open:'",
  ],
  [
    "bad/category-open-null.yaml",
    1,
    "category 'area' declares neither 'labels:' nor 'open:'",
  ],
  [
    "bad/category-open-bad-regex.yaml",
    1,
    "category 'pattern' has an 'open:' that does not compile",
  ],
  [
    "bad/category-max-not-positive.yaml",
    1,
    "category 'area' has a 'max:' that is not a positive integer",
  ],
  [
    "bad/category-recommended-not-boolean.yaml",
    1,
    "category 'area' has a 'recommended:' that is not true or false",
  ],
  [
    "bad/category-requires-unknown.yaml",
    1,
    "category 'stage' requires 'area:delivery', which is not",
  ],
  [
    "bad/flag-requires-category-unknown.yaml",
    1,
    "flag 'hitl' has requires_category 'hitl-stakeholder', which is not a category",
  ],
  ["good/label-taxonomy.yaml", 0, "OK — labels valid"],
  [
    "good/groups-categories.yaml",
    0,
    "OK — labels valid (types=3, statuses=3, flags=3, groups=2, categories=4)",
  ],
];
for (const [name, code, expected] of cases)
  test(name, () => {
    const run = lint(fixture(name));
    const out = run.stdout.toString();
    expectSpawnExit(run, code);
    expect(out).toContain(expected);
    if (code === 1) expect(out).toContain("FAILED: 1 problem(s)");
  });

test("the module's template passes", () => {
  const template = join(
    import.meta.dir,
    "../../../../modules/M9-tasks-memory/templates/label-taxonomy.yaml",
  );
  const run = lint(template);
  expectSpawnExit(run, 0);
  expect(run.stdout.toString()).toMatch(/groups=[1-9].*categories=[1-9]/);
});

test("a missing file, or a second argument, is a usage error", () => {
  expectSpawnExit(lint(fixture("missing.yaml")), 2);
  const two = Bun.spawnSync([
    process.execPath,
    script,
    fixture("good/label-taxonomy.yaml"),
    "extra",
  ]);
  expectSpawnExit(two, 2);
});

test("without a path it reads TAXONOMY, else the repository's issue_tracker.taxonomy", () => {
  const fromEnv = lint("", { TAXONOMY: fixture("bad/duplicate-id.yaml") });
  expectSpawnExit(fromEnv, 1);
  const repo = mkdtempSync(join(tmpdir(), "taxonomy-config-"));
  const dir = join(repo, ".config");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "jig.yaml"),
    `issue_tracker:\n  taxonomy: ${JSON.stringify(fixture("good/groups-categories.yaml"))}\n`,
  );
  const fromConfig = Bun.spawnSync([process.execPath, script], {
    cwd: repo,
    env: {
      ...process.env,
      JIG_CONSUMER_ROOT: repo,
      JIG_OVERLAY: join(dir, "jig.yaml"),
      TAXONOMY: "",
    },
  });
  expectSpawnExit(fromConfig, 0);
  expect(fromConfig.stdout.toString()).toContain("categories=4");
});

test("every YAML spelling of an entry is read, and what is not text is rejected", () => {
  const head = "types:\n  - id: feature\nstatuses:\n  - id: todo\n";
  const flag = "    scope: shipping-item\n    apply_when: always\n";
  const cases: [string, number, string][] = [
    [
      `${head}flags: [{id: has-migration}]\n`,
      1,
      "flag 'has-migration' declares no 'fires:'",
    ],
    [`${head}flags: false\n`, 1, "'flags:' is not a list"],
    [`${head}"flags":\n  - id: hitl\n`, 1, "flag 'hitl' declares no 'fires:'"],
    [`${head}"extra": 1\n`, 1, "unknown top-level key 'extra:'"],
    [`${head}flags:\n  -\n    id: hitl\n    fires: review\n${flag}`, 0, ""],
    [
      `${head}flags:\n  - id: hitl\n    fires: [null]\n${flag}`,
      1,
      "'fires:' that is not a text",
    ],
    [
      `${head}flags:\n  - id: hitl\n    fires: review\n    scope: shipping-item\n    apply_when:\n      - ~\n`,
      1,
      "'apply_when:' that is not a text",
    ],
    [
      `types:\n  - id: [feature, bug]\n${head.slice(head.indexOf("statuses"))}`,
      1,
      "id that is not a single name",
    ],
    [
      `types:\n  - id: 1\n${head.slice(head.indexOf("statuses"))}`,
      1,
      "id that is not a single name",
    ],
    [
      `types:\n  - id: " feature "\n${head.slice(head.indexOf("statuses"))}`,
      0,
      "",
    ],
    [
      `types:\n  - id: "api,change"\nstatuses:\n  - id: todo\nflags:\n  - id: hitl\n    fires: review\n${flag}    requires: ["api,change"]\n`,
      0,
      "",
    ],
    [
      `${head}flags:\n  - id: hitl\n    fires:\n    fires: review\n${flag}`,
      1,
      "duplicate 'fires:' field on line 8",
    ],
    [
      `${head}groups: [{id: size, labels: [{id: small}, {id: large}]}]\n`,
      0,
      "",
    ],
    [
      `${head}categories:\n  - {id: area, prefix: "area:", labels: [{id: x}], requires: [{a: 1}]}\n`,
      1,
      "'requires:' that is not a text",
    ],
    [
      `${head}categories:\n  - {id: pattern, prefix: "pattern:", open: "^[a-z]+$", requires: [feature]}\n`,
      0,
      "",
    ],
    [
      `${head}categories:\n  - {id: area, prefix: "area:", labels: [{id: x}], requires: ["area:x"]}\n`,
      1,
      "category 'area' requires 'area:x', one of its own labels",
    ],
  ];
  for (const [body, code, expected] of cases) {
    const { problems } = lintTaxonomyText(body);
    expect({ body, failed: problems.length > 0 }).toEqual({
      body,
      failed: code === 1,
    });
    if (expected) expect(problems.join("\n")).toContain(expected);
  }
});

test("a requires may name any label of the file, a closed category label included", () => {
  const { problems, taxonomy } = lintTaxonomyText(
    readFileSync(fixture("good/groups-categories.yaml"), "utf8"),
  );
  expect(problems).toEqual([]);
  expect(taxonomy?.categories.map((c) => c.labels.length)).toEqual([
    3, 2, 1, 2,
  ]);
  expect(
    taxonomy?.flags.find((f) => f.id === "hitl")?.requiresCategory,
  ).toEqual(["hitl-stakeholder"]);
});
