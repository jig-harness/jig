import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CATALOG,
  type Catalog,
  catalogProblems,
  checkChangeAreas,
  readCatalog,
  resolveAreas,
  uncoveredFiles,
} from "./change-areas.ts";

const root = resolve(import.meta.dir, "..");

function area(paths: string[], impliedBy: string[] = [], category = "skill") {
  return {
    title: "An area",
    category,
    paths,
    workspace: [],
    impliedBy,
    deployTier: "none",
  };
}

const catalog: Catalog = {
  app: area(["app/**"], ["core"]),
  core: area(["core/**"], ["build"], "library"),
  build: area(["package.json"], [], "infra"),
  other: area(["other/**"]),
  docs: area(["*.md", "docs/**"], [], "docs"),
};

test("a change seeds its own areas and every area that implies-by closure adds", () => {
  expect(resolveAreas(["core/index.ts"], catalog)).toMatchObject({
    seedAreas: ["core"],
    areas: ["app", "core"],
    code: true,
  });
  // Two hops: build implies core, core implies app.
  expect(resolveAreas(["package.json"], catalog).areas).toEqual([
    "app",
    "core",
    "build",
  ]);
  expect(resolveAreas(["app/main.ts"], catalog).areas).toEqual(["app"]);
});

test("a documentation-only change is not code, and an unmatched file is", () => {
  expect(resolveAreas(["README.md", "docs/a/b.md"], catalog)).toMatchObject({
    areas: ["docs"],
    code: false,
  });
  // `*.md` matches the root only.
  expect(resolveAreas(["other/README.md"], catalog).areas).toEqual(["other"]);
  expect(resolveAreas(["stray.txt"], catalog)).toMatchObject({
    areas: [],
    unmatched: ["stray.txt"],
    code: true,
  });
  expect(resolveAreas([], catalog)).toMatchObject({ areas: [], code: false });
});

test("files no area matches are reported", () => {
  expect(uncoveredFiles(["app/x.ts", "stray.txt", "a.md"], catalog)).toEqual([
    "stray.txt",
  ]);
});

// The closed sets live in the catalog, as Jig's own does.
const vocabularies = {
  category: ["skill", "library", "tooling", "infra", "docs"],
  deployTier: ["plugin", "none"],
};

test("the schema and graph checks reject malformed catalogs", () => {
  expect(catalogProblems({ vocabularies, areas: catalog })).toEqual([]);
  expect(catalogProblems({})).toEqual(["the catalog has no `areas` map"]);
  const problems = (areas: Record<string, unknown>) =>
    catalogProblems({ vocabularies, areas }).join("\n");
  expect(problems({ Bad_Id: area(["x"]) })).toContain("not kebab-case");
  expect(problems({ a: { ...area(["x"]), reviews: [] } })).toContain(
    "unknown field `reviews`",
  );
  expect(problems({ a: { ...area(["x"]), category: "app" } })).toContain(
    'category `"app"`',
  );
  expect(problems({ a: { ...area(["x"]), deployTier: "prod" } })).toContain(
    'deployTier `"prod"`',
  );
  expect(problems({ a: { ...area(["x"]), reviewRisk: "low" } })).toContain(
    'reviewRisk `"low"`',
  );
  expect(problems({ a: { ...area(["x"]), reviewRisk: "high" } })).toBe("");
  // The derived files an area owns take M2's inventory shape, checked by
  // the runner's own validation: an entry without a check is refused.
  // The shipped schema and M2's runner both check an entry's shape; a
  // problem both find is listed once.
  expect(problems({ a: { ...area(["x"]), generated: {} } })).toBe(
    "a: generated: must be a list of entries",
  );
  expect(
    problems({
      a: {
        ...area(["x"]),
        generated: [{ outputs: ["x/out"], source: ["x/src"], command: "gen" }],
      },
    }),
  ).toContain("generated[0].check: must be a command");
  expect(
    problems({
      a: {
        ...area(["x"]),
        generated: [
          {
            outputs: ["x/out"],
            source: ["x/src"],
            command: "gen",
            check: "gen --check",
          },
        ],
      },
    }),
  ).toBe("");
  expect(problems({ a: area([]) })).toContain("at least one glob");
  const { title: _, ...untitled } = area(["x"]);
  expect(problems({ a: untitled })).toContain("`title` is missing");
  expect(problems({ a: area(["x"], ["a"]) })).toContain("implies itself");
  expect(problems({ a: area(["x"], ["ghost"]) })).toContain(
    "unknown area `ghost`",
  );
  // Membership is an own-property check: a name every object inherits is
  // neither a known field nor a declared area.
  expect(problems({ a: { ...area(["x"]), constructor: "x" } })).toContain(
    "unknown field `constructor`",
  );
  expect(problems({ a: area(["x"], ["constructor"]) })).toContain(
    "unknown area `constructor`",
  );
  // An enum value must be text, not a list whose text form happens to match.
  expect(problems({ a: { ...area(["x"]), category: ["docs"] } })).toContain(
    'category `["docs"]`',
  );
  expect(problems({ a: { ...area(["x"]), deployTier: ["none"] } })).toContain(
    'deployTier `["none"]`',
  );
  expect(
    problems({
      a: area(["a"], ["c"]),
      b: area(["b"], ["a"]),
      c: area(["c"], ["b"]),
    }),
  ).toContain("impliedBy cycle: a -> c -> b -> a");
});

test("Jig's catalog is valid and every repository file belongs to an area", () => {
  expect(checkChangeAreas(root)).toBe(0);
});

test("Jig's catalog runs the drive-pr suite for what it depends on, and not for documentation", () => {
  const jig = (readCatalog(join(root, CATALOG)) as { areas: Catalog }).areas;
  const areas = (file: string) => resolveAreas([file], jig).areas;
  for (const file of [
    "plugin/skills/drive-pr/scripts/drive.ts",
    "plugin/skills/drive-pr/SKILL.md",
    "plugin/shared/proc.ts",
    "plugin/skills/do-item/scripts/lib/tracker/port.ts",
    "lib/test-tmpdir-bun-preload.ts",
    "bun.lock",
    ".github/workflows/gates.yml",
    ".config/jig.yaml",
  ])
    expect(areas(file)).toContain("drive-pr");
  for (const file of [
    "README.md",
    "modules/M3-change-area-catalog/README.md",
    "design/reflection.md",
    "plugin/skills/audit/SKILL.md",
    "scripts/check-md-links.ts",
  ])
    expect(areas(file)).not.toContain("drive-pr");
  expect(
    resolveAreas(
      ["README.md", "modules/M1-gates-enforcement-ladder/mappings.md"],
      jig,
    ).code,
  ).toBe(false);
  expect(
    resolveAreas(
      ["modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet.ts"],
      jig,
    ).code,
  ).toBe(true);
});

test("a catalog that repeats an area is refused, not read as its last copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-areas-"));
  try {
    const path = join(dir, "catalog.yaml");
    const entry =
      "  docs:\n    title: Docs\n    category: docs\n    paths: ['*.md']\n    workspace: []\n    impliedBy: []\n    deployTier: none\n";
    writeFileSync(path, `areas:\n${entry}`);
    expect(catalogProblems(readCatalog(path))).toEqual([]);
    writeFileSync(path, `areas:\n${entry}${entry}`);
    expect(() => readCatalog(path)).toThrow(/duplicated mapping key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
