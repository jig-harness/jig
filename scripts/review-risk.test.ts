import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoFiles } from "../lib/files.ts";
import { CATALOG, type Catalog, validCatalog } from "./change-areas.ts";
import {
  checkReviewRisk,
  committedPatterns,
  globToRegex,
  projectPatterns,
  REVIEW_CONFIG,
  renderBlock,
} from "./review-risk.ts";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function area(paths: string[], reviewRisk?: string) {
  return {
    title: "An area",
    category: "tooling",
    paths,
    workspace: [],
    impliedBy: [],
    deployTier: "none",
    ...(reviewRisk ? { reviewRisk } : {}),
  };
}

test("a glob becomes the reviewer's anchored pattern", () => {
  expect(globToRegex("scripts/**")).toBe("^scripts/");
  expect(globToRegex(".config/ai-review.yaml")).toBe(
    "^\\.config/ai-review\\.yaml$",
  );
  expect(globToRegex("modules/*/reference/**")).toBe(
    "^modules/[^/]*/reference/",
  );
  expect(globToRegex("criteria/M?.yaml")).toBe("^criteria/M[^/]\\.yaml$");
  expect(globToRegex("a/**/b.ts")).toBe("^a/(?:[\\s\\S]*/)?b\\.ts$");
  for (const glob of ["a/{b,c}.ts", "a/[bc].ts", "!index.ts", "a/\\*.ts"])
    expect(() => globToRegex(glob)).toThrow("not supported");
});

test("each pattern matches exactly the paths its glob matches", () => {
  const globs = [
    "scripts/**",
    "a/**/b.ts",
    "a/*.ts",
    "a/?.ts",
    "modules/*/reference/**",
    "plugin/skills/audit/criteria/M*.yaml",
    "x.y+z(1).md",
  ];
  const paths = [
    "scripts/a.ts",
    "scripts/x/y.ts",
    "scriptsx/a.ts",
    "a/b.ts",
    "a/x/y/b.ts",
    "a/x\ny/b.ts",
    "a/xb.ts",
    "a/c.ts",
    "a/cd.ts",
    "a/c/d.ts",
    "modules/M1-gates/reference/a/b.ts",
    "modules/M1-gates/templates/a.md",
    "modules/reference/a.ts",
    "plugin/skills/audit/criteria/M3-change-area-catalog.yaml",
    "plugin/skills/audit/criteria/README.md",
    "x.y+z(1).md",
    "xay+z(1).md",
  ];
  const agree = (glob: string, path: string) =>
    expect([glob, path, new RegExp(globToRegex(glob)).test(path)]).toEqual([
      glob,
      path,
      new Bun.Glob(glob).match(path),
    ]);
  for (const glob of globs) for (const path of paths) agree(glob, path);
  // Jig's own high-risk globs agree with the catalog's matcher on every file.
  const catalog = validCatalog(root);
  const files = repoFiles(root);
  for (const area of Object.values(catalog).filter(
    (a) => a.reviewRisk === "high",
  ))
    for (const glob of area.paths) for (const file of files) agree(glob, file);
});

test("only areas marked high project their paths, in catalog order, once each", () => {
  const catalog: Catalog = {
    a: area(["a/**", "shared.md"], "high"),
    b: area(["b/**"]),
    c: area(["shared.md", "c.ts"], "high"),
  };
  expect(projectPatterns(catalog)).toEqual([
    "^a/",
    "^shared\\.md$",
    "^c\\.ts$",
  ]);
});

test("the block is rewritten in place and read back", () => {
  const config =
    "x: 1\n\nhigh_risk_path_patterns:\n  - source: '^old/'\n\nrules:\n  - id: r\n";
  const rendered = renderBlock(config, ["^a/", "^it's$"]);
  expect(rendered).toBe(
    "x: 1\n\nhigh_risk_path_patterns:\n  - source: '^a/'\n  - source: '^it''s$'\n\nrules:\n  - id: r\n",
  );
  expect(committedPatterns(rendered)).toEqual(["^a/", "^it's$"]);
  expect(() => renderBlock("x: 1\n", [])).toThrow("high_risk_path_patterns");
  // An empty projection is an empty list, which reads back and rewrites.
  const empty = renderBlock(config, []);
  expect(committedPatterns(empty)).toEqual([]);
  expect(committedPatterns(renderBlock(empty, ["^b/"]))).toEqual(["^b/"]);
  // List items at the margin and comments among them belong to the block;
  // a comment just before the next key stays with that key.
  const indentless =
    "high_risk_path_patterns:\n- source: '^old/'\n# between\n- source: '^older/'\n\n# rules follow\nrules: []\n";
  expect(renderBlock(indentless, ["^a/"])).toBe(
    "high_risk_path_patterns:\n  - source: '^a/'\n\n# rules follow\nrules: []\n",
  );
});

test("the gate passes on Jig and fails when the list and the catalog differ", () => {
  expect(checkReviewRisk(root)).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), "jig-review-risk-"));
  temporary.push(dir);
  mkdirSync(join(dir, ".config"));
  expect(checkReviewRisk(dir)).toBe(2);
  writeFileSync(join(dir, CATALOG), readFileSync(join(root, CATALOG)));
  const config = readFileSync(join(root, REVIEW_CONFIG), "utf8");
  writeFileSync(join(dir, REVIEW_CONFIG), config);
  expect(checkReviewRisk(dir)).toBe(0);
  writeFileSync(
    join(dir, REVIEW_CONFIG),
    config.replace("  - source: '^scripts/'\n", ""),
  );
  expect(checkReviewRisk(dir)).toBe(1);
});
