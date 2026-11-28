import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { lintTaxonomyText, type Taxonomy } from "../scripts/lib/taxonomy.ts";
import { declaresLabel, validateLabels } from "../scripts/lib/validate.ts";
import { type Deps, main } from "../scripts/validate-labels.ts";

const lintScript = join(
  import.meta.dir,
  "..",
  "scripts",
  "check-label-taxonomy.ts",
);

/** A taxonomy with one field-only category beside the given YAML lines. */
const taxonomyText = (category: string, extra = "") => `version: 1
types: [{ id: feature }, { id: bug }]
statuses: [{ id: todo }]
flags:
  - id: hitl
    fires: [human-review]
    scope: shipping-item
    apply_when: a person decides
${extra}
categories:
  - id: area
    prefix: "area:"
    labels: [{ id: api }]
  - id: fixversion
    prefix: "fixversion:"
${category}
`;

const FIELD_ONLY = `    field_only: true
    open: "[0-9][0-9.]*"
    labels: [{ id: "2.4" }]`;

const problemsOf = (text: string) => lintTaxonomyText(text).problems;
const taxonomy = lintTaxonomyText(taxonomyText(FIELD_ONLY))
  .taxonomy as Taxonomy;

describe("the taxonomy lint and a field-only category", () => {
  test("accepts a category that declares itself field-only", () => {
    const lint = lintTaxonomyText(taxonomyText(FIELD_ONLY));
    expect(lint.problems).toEqual([]);
    const categories = lint.taxonomy?.categories ?? [];
    expect(categories.map((c) => [c.id, c.fieldOnly])).toEqual([
      ["area", false],
      ["fixversion", true],
    ]);
  });

  test("refuses a field_only that is not true or false", () => {
    for (const value of ["yes", "1", "null", "[true]"])
      expect(
        problemsOf(
          taxonomyText(`    field_only: ${value}\n    open: "[0-9.]+"`),
        ),
      ).toEqual([
        "category 'fixversion' has a 'field_only:' that is not true or false",
      ]);
  });

  test("refuses field_only beside recommended, and on any entry but a category", () => {
    expect(
      problemsOf(taxonomyText(`${FIELD_ONLY}\n    recommended: true`)),
    ).toEqual([
      "category 'fixversion' is 'field_only: true' and 'recommended: true' (its values are set on the tracker field after filing, so a filing never carries one)",
    ]);
    const onFlag = problemsOf(
      taxonomyText(
        FIELD_ONLY,
        "  - id: ops\n    fires: [x]\n    scope: container\n    apply_when: y\n    field_only: true",
      ),
    );
    expect(onFlag).toHaveLength(1);
    expect(onFlag[0]).toContain(
      "'flags' entry 'ops' has an unknown key 'field_only:'",
    );
  });

  test("refuses a requires or requires_category no filing could meet", () => {
    const flagRequires = problemsOf(
      taxonomyText(
        FIELD_ONLY,
        '  - id: release\n    fires: [x]\n    scope: shipping-item\n    apply_when: y\n    requires: ["fixversion:2.4"]\n    requires_category: [fixversion]',
      ),
    );
    expect(flagRequires).toEqual([
      "flag 'release' requires 'fixversion:2.4', a label of field-only category 'fixversion' whose values are set on the tracker field after filing, so a filing never carries one",
      "flag 'release' has requires_category 'fixversion', a field-only category whose values are set on the tracker field after filing, so a filing never carries one",
    ]);
    const categoryRequires = problemsOf(
      taxonomyText(FIELD_ONLY).replace(
        "labels: [{ id: api }]",
        'labels: [{ id: api }]\n    requires: ["fixversion:2.4"]',
      ),
    );
    expect(categoryRequires).toEqual([
      "category 'area' requires 'fixversion:2.4', a label of field-only category 'fixversion' whose values are set on the tracker field after filing, so a filing never carries one",
    ]);
  });

  test("a field-only category requiring its own label is reported once", () => {
    expect(
      problemsOf(
        taxonomyText(`${FIELD_ONLY}\n    requires: ["fixversion:2.4"]`),
      ),
    ).toEqual([
      "category 'fixversion' requires 'fixversion:2.4', one of its own labels",
    ]);
  });

  test("the lint command passes a field-only category and fails a malformed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "field-only-lint-"));
    const good = join(dir, "good.yaml");
    const bad = join(dir, "bad.yaml");
    writeFileSync(good, taxonomyText(FIELD_ONLY));
    writeFileSync(
      bad,
      taxonomyText('    field_only: "true"\n    open: "[0-9.]+"'),
    );
    const lint = (path: string) =>
      Bun.spawnSync([process.execPath, lintScript, path]);
    expectSpawnExit(lint(good), 0);
    const failed = lint(bad);
    expectSpawnExit(failed, 1);
    expect(failed.stdout.toString()).toContain(
      "category 'fixversion' has a 'field_only:' that is not true or false",
    );
  });
});

describe("the label validator and a field-only category", () => {
  test("knows its labels, warns where they go, and leaves them out of the labels to write", () => {
    const result = validateLabels(
      ["feature", "area:api", "fixversion:2.4", "fixversion:3.0.1"],
      taxonomy,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.labels).toEqual(["feature", "area:api"]);
    expect(result.fieldOnly).toEqual(["fixversion:2.4", "fixversion:3.0.1"]);
    expect(result.parsed.unknown).toEqual([]);
    expect(result.warnings).toEqual([
      "'fixversion:2.4', 'fixversion:3.0.1' are values of field-only category 'fixversion': set them on the tracker field after filing, not as labels (left out of the labels to write)",
    ]);
    expect(declaresLabel(taxonomy, "fixversion:2.4")).toBe(true);
  });

  test("still refuses a value its pattern does not match, and names no field-only label when none is given", () => {
    const bad = validateLabels(["feature", "fixversion:next"], taxonomy);
    expect(bad.valid).toBe(false);
    expect(bad.errors).toEqual([
      "'fixversion:next' is not a valid 'fixversion:' label: its slug must match ^(?:[0-9][0-9.]*)$",
    ]);
    const plain = validateLabels(["feature", "area:api"], taxonomy);
    expect(plain.fieldOnly).toEqual([]);
    expect(plain.warnings).toEqual([]);
  });

  test("without the declaration the label is an ordinary one, and without the category it is unknown", () => {
    const plain = lintTaxonomyText(taxonomyText('    open: "[0-9][0-9.]*"'))
      .taxonomy as Taxonomy;
    const ordinary = validateLabels(["feature", "fixversion:2.4"], plain);
    expect(ordinary.fieldOnly).toEqual([]);
    expect(ordinary.labels).toEqual(["feature", "fixversion:2.4"]);
    const absent = lintTaxonomyText(
      taxonomyText('    open: "[0-9][0-9.]*"').replace(
        / {2}- id: fixversion[\s\S]*$/,
        "",
      ),
    ).taxonomy as Taxonomy;
    const unknown = validateLabels(["feature", "fixversion:2.4"], absent);
    expect(unknown.valid).toBe(false);
    expect(unknown.errors).toEqual([
      "unknown label: fixversion:2.4 (not in the taxonomy)",
    ]);
  });
});

describe("validate-labels.ts with a field-only category", () => {
  const dir = mkdtempSync(join(tmpdir(), "field-only-validate-"));
  const path = join(dir, "label-taxonomy.yaml");
  writeFileSync(path, taxonomyText(FIELD_ONLY));
  const labels = ["feature", "area:api", "fixversion:2.4"];

  const capture = async (argv: string[], deps: Deps) => {
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (line: string) => lines.push(line);
    console.error = (line: string) => lines.push(line);
    try {
      return { code: await main(argv, deps), out: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  /** A tracker whose labels are `names`, recording which it was asked about. */
  const tracker = (names: string[]) => {
    let opened = 0;
    const deps: Deps = {
      openTracker: () => {
        opened++;
        return {
          listLabels: async () => names.map((name) => ({ name, group: null })),
        };
      },
      readStdin: async () => "",
    };
    return { deps, opened: () => opened };
  };

  test("without --check-tracker: valid, with the post-filing note", async () => {
    const { deps, opened } = tracker([]);
    const { code, out } = await capture(["--taxonomy", path, ...labels], deps);
    expect(code).toBe(0);
    expect(out).toContain("VALID (2 labels)");
    expect(out).toContain(
      "WARNING: 'fixversion:2.4' is a value of field-only category 'fixversion': set it on the tracker field after filing, not as a label",
    );
    expect(opened()).toBe(0);
  });

  test("with --check-tracker: no tracker label is looked up for a field-only value", async () => {
    const { deps, opened } = tracker(["feature", "area:api"]);
    const { code, out } = await capture(
      ["--check-tracker", "--json", "--taxonomy", path, ...labels],
      deps,
    );
    expect(code).toBe(0);
    expect(opened()).toBe(1);
    const result = JSON.parse(out);
    expect(result.valid).toBe(true);
    expect(result.labels).toEqual(["feature", "area:api"]);
    expect(result.fieldOnly).toEqual(["fixversion:2.4"]);
    expect(result.errors).toEqual([]);
  });

  test("with --check-tracker and a filing draft: placement is read, and the field-only value is still left out", async () => {
    const file = join(dir, "draft.json");
    writeFileSync(
      file,
      JSON.stringify({
        title: "Ship it",
        description: "Body",
        labels: ["area:api", "fixversion:2.4"],
        type: "feature",
        priority: 3,
      }),
    );
    const drafts: string[][] = [];
    const deps: Deps = {
      openTracker: () => ({
        listLabels: async () =>
          ["feature", "area:api"].map((name) => ({ name, group: null })),
        filedAs: async (draft) => {
          drafts.push(draft.labels);
          return { nativeType: null, labels: draft.labels };
        },
        unavailableFacets: async () => [],
      }),
      readStdin: async () => "",
    };
    const { code, out } = await capture(
      ["--check-tracker", "--json", "--taxonomy", path, "--input", file],
      deps,
    );
    expect(code).toBe(0);
    expect(drafts).toHaveLength(1);
    const result = JSON.parse(out);
    expect(result.labels).toEqual(["area:api"]);
    expect(result.fieldOnly).toEqual(["fixversion:2.4"]);
  });

  test("with --check-tracker: a real label still missing from the tracker fails", async () => {
    const { deps } = tracker(["feature"]);
    const { code, out } = await capture(
      ["--check-tracker", "--taxonomy", path, ...labels],
      deps,
    );
    expect(code).toBe(3);
    expect(out).toContain("not in the tracker: area:api");
    expect(out).not.toContain("not in the tracker: area:api, fixversion");
  });
});
