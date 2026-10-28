/**
 * The project type read from the tracked files, the documents each type
 * expects, and the settings detected when the configuration is silent.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  decisionDirectory,
  detectProjectType,
  expectedDocuments,
} from "../scripts/lib/plan.ts";
import {
  canonicalPath,
  findSchema,
  parseDocsSettings,
} from "../scripts/lib/settings.ts";
import { temporary, write } from "./helpers.ts";

/** A folder holding `files`; the paths are what git would list. */
function tree(files: Record<string, string>): [string, string[]] {
  const root = temporary();
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return [root, Object.keys(files)];
}

describe("the project type", () => {
  const cases: [string, Record<string, string>, string, string][] = [
    [
      "a deploy file makes a service",
      { "api/Dockerfile": "", "package.json": "{}" },
      "service",
      "api/Dockerfile",
    ],
    [
      "a chart folder makes a service",
      { "helm/values.yaml": "" },
      "service",
      "helm/values.yaml",
    ],
    [
      "a published package makes a library",
      { "package.json": '{"name":"x","exports":"./i.js"}' },
      "library",
      "package.json (a published package)",
    ],
    [
      "a private package is an application",
      { "package.json": '{"private":true,"main":"i.js"}' },
      "application",
      "package.json",
    ],
    [
      "a Rust library crate",
      { "Cargo.toml": "", "src/lib.rs": "" },
      "library",
      "src/lib.rs (a Rust library crate)",
    ],
    [
      "a Rust binary is an application",
      { "Cargo.toml": "", "src/lib.rs": "", "src/main.rs": "" },
      "application",
      "Cargo.toml",
    ],
    [
      "a Python package without scripts",
      { "pyproject.toml": "[project]\nname = 'x'\n" },
      "library",
      "pyproject.toml (a Python package)",
    ],
    [
      "test fixtures say nothing about the project",
      { "tests/fixtures/Dockerfile": "" },
      "unknown",
      "no build manifest or deploy file",
    ],
    [
      "invalid JSON decides nothing",
      { "package.json": "{" },
      "application",
      "package.json",
    ],
  ];
  for (const [label, files, type, evidence] of cases)
    test(label, () => {
      const [root, paths] = tree(files);
      expect(detectProjectType(root, paths)).toEqual({
        type,
        evidence,
      } as never);
    });

  test("an untracked pyproject.toml decides nothing", () => {
    const [root] = tree({ "pyproject.toml": "[project]\nname = 'x'\n" });
    expect(detectProjectType(root, [])).toEqual({
      type: "unknown",
      evidence: "no build manifest or deploy file",
    });
  });
});

describe("the expected documents", () => {
  test("a document's type: stands in for the conventional folder", () => {
    const [root] = tree({
      "docs/ops/restart.md": "---\ntype: runbook\n---\n",
      "docs/log.md": "# Log\n",
    });
    const found = Object.fromEntries(
      expectedDocuments(root, "docs", null, "service", null).map((e) => [
        e.id,
        e.found,
      ]),
    );
    expect(found.runbooks).toBe("docs/ops/restart.md");
    expect(found["activity-log"]).toBe("docs/log.md");
    expect(found.index).toBeNull();
  });

  test("a type: adr document stands in for the decision-records folder", () => {
    const [root] = tree({ "docs/design/cache.md": "---\ntype: adr\n---\n" });
    const records = expectedDocuments(root, "docs", null, "unknown", null).find(
      (e) => e.id === "decision-records",
    );
    expect(records?.found).toBe("docs/design/cache.md");
  });

  test("a configured decision-records folder must exist", () => {
    const [root] = tree({ "docs/adr/ADR-0001-x.md": "" });
    expect(decisionDirectory(root, "docs/adr")).toBe("docs/adr");
    expect(() => decisionDirectory(root, "handbook/missing")).toThrow(
      "adr.directory is handbook/missing, which is not a directory",
    );
    expect(decisionDirectory(root)).toBe("docs/adr");
  });

  test("each type adds its own pages to the common ones", () => {
    const ids = (type: "service" | "library" | "application" | "unknown") =>
      expectedDocuments(temporary(), null, null, type, null).map((e) => e.id);
    const common = ids("unknown");
    expect(ids("service")).toEqual([...common, "architecture", "runbooks"]);
    expect(ids("library")).toEqual([...common, "guide", "reference"]);
    expect(ids("application")).toEqual([...common, "architecture", "guide"]);
  });
});

describe("the detected settings", () => {
  test("the shallowest schema under the docs tree wins", () => {
    const [root] = tree({
      "docs/deep/er/frontmatter-schema.yaml": "",
      "docs/meta/.frontmatter-schema.yaml": "",
    });
    expect(findSchema(root, "docs")).toBe("docs/meta/.frontmatter-schema.yaml");
  });

  test("the root is the first candidate folder that exists", () => {
    const root = temporary();
    mkdirSync(join(root, "doc"));
    expect(parseDocsSettings(undefined, root)).toMatchObject({
      root: "doc",
      schema: null,
      staleAfterDays: 180,
      detected: { root: true, schema: true },
    });
  });

  test("a configured path is spelled the way git prints it", () => {
    for (const spelling of ["docs", "./docs", "docs/", "./docs//", "docs/./"])
      expect(canonicalPath(spelling)).toBe("docs");
    expect(canonicalPath("./")).toBe(".");
    const root = temporary();
    mkdirSync(join(root, "docs"));
    expect(parseDocsSettings({ root: "./docs/" }, root).root).toBe("docs");
  });

  test("a threshold that is not a whole number of days is refused", () => {
    for (const bad of [0, 1.5, "30"])
      expect(() =>
        parseDocsSettings({ stale_after_days: bad }, temporary()),
      ).toThrow("docs.stale_after_days must be a whole number");
  });
});
