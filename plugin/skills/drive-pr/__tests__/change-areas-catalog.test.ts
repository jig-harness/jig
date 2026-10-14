/**
 * The plugin's one change-area catalog reader: area validation, the tracker
 * block in both spellings, path globs and direct path → area matching.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areasOf,
  globProblem,
  globToRegExp,
  loadCatalogFile,
  parseCatalog,
} from "../scripts/lib/change-areas-catalog.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseCatalog", () => {
  it("reads generated sources and the nested tracker-label forms", () => {
    const catalog = loadCatalogFile(
      join(FIXTURES, "change-areas-catalog.yaml"),
    );
    expect(catalog.get("api")?.globs).toContain("tools/codegen/**");
    expect(catalog.get("delivery-tools")?.labels).toEqual(["delivery-system"]);
    expect(catalog.get("ci")?.labels).toEqual(["delivery-system"]);
  });

  it("reads tracker.labels and tracker.flags", () => {
    const area = parseCatalog({
      areas: {
        auth: {
          paths: ["src/auth/**"],
          labels: ["own"],
          tracker: { labels: ["area:auth"], flags: ["security", "privacy"] },
        },
      },
    }).get("auth");
    expect(area?.labels).toEqual(["own", "area:auth"]);
    expect(area?.trackerLabels).toEqual(["area:auth"]);
    expect(area?.flags).toEqual(["security", "privacy"]);
  });

  it("reads linear.labels and linear.flags as the older spelling", () => {
    const area = parseCatalog({
      areas: {
        auth: {
          paths: ["src/auth/**"],
          linear: { labels: ["area:auth"], flags: ["security"] },
        },
      },
    }).get("auth");
    expect(area?.labels).toEqual(["area:auth"]);
    expect(area?.trackerLabels).toEqual(["area:auth"]);
    expect(area?.flags).toEqual(["security"]);
  });

  it("joins both spellings when a catalog carries both, tracker first", () => {
    const area = parseCatalog({
      areas: {
        auth: {
          tracker: { labels: ["a"], flags: ["f1"] },
          linear: { labels: ["b"], flags: ["f2"] },
        },
      },
    }).get("auth");
    expect(area?.labels).toEqual(["a", "b"]);
    expect(area?.flags).toEqual(["f1", "f2"]);
  });

  it("keeps every other field of an area as written", () => {
    const area = parseCatalog({
      areas: { api: { paths: ["src/**"], agent: "Backend Agent", x: 1 } },
    }).get("api");
    expect(area?.fields.agent).toBe("Backend Agent");
    expect(area?.fields.x).toBe(1);
  });

  it("refuses a catalog without an areas mapping", () => {
    for (const raw of [null, [], {}, { areas: [] }, { areas: null }])
      expect(() => parseCatalog(raw)).toThrow("has no `areas` mapping");
    expect(() => parseCatalog({ areas: { ci: [] } })).toThrow(
      "catalog area ci: not a mapping",
    );
  });

  it("refuses a glob that compiles to no pattern, naming its field", () => {
    for (const glob of ["src/{a,b", "a/{b,{c}", "[z-a].ts"])
      expect(() =>
        parseCatalog({ areas: { ci: { paths: ["ok/**", glob] } } }),
      ).toThrow(`catalog area ci.paths[1]: "${glob}" is not a valid glob`);
    expect(() =>
      parseCatalog({
        areas: {
          ci: { generated: [{ source: ["ok/**"] }, { source: ["a", "x{"] }] },
        },
      }),
    ).toThrow(
      'catalog area ci.generated[1].source[1]: "x{" is not a valid glob',
    );
  });

  it("refuses a tracker block that is not a mapping, in either spelling", () => {
    for (const block of ["tracker", "linear"])
      for (const value of [["delivery-system"], null])
        expect(() =>
          parseCatalog({
            areas: {
              ci: { paths: [".github/**"], [block]: value },
            },
          }),
        ).toThrow(`catalog area ci.${block}: not a mapping`);
  });

  it("refuses a present-but-null field anywhere in an area, and reads an omitted one as empty", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ paths: null }, "catalog area ci.paths: expected a list of strings"],
      [{ labels: null }, "catalog area ci.labels: expected a list of strings"],
      [
        { tracker: { labels: null } },
        "catalog area ci.tracker.labels: expected a list of strings",
      ],
      [
        { tracker: { flags: null } },
        "catalog area ci.tracker.flags: expected a list of strings",
      ],
      [
        { linear: { labels: null } },
        "catalog area ci.linear.labels: expected a list of strings",
      ],
      [
        { linear: { flags: [1] } },
        "catalog area ci.linear.flags: expected a list of strings",
      ],
      [{ generated: null }, "catalog area ci.generated: expected a list"],
      [{ generated: [null] }, "catalog area ci.generated[0]: not a mapping"],
      [
        { generated: [{ source: null }] },
        "catalog area ci.generated[0].source: expected a list of strings",
      ],
    ];
    for (const [area, message] of cases)
      expect(() =>
        parseCatalog({ areas: { ci: { paths: [".github/**"], ...area } } }),
      ).toThrow(message);
    const empty = parseCatalog({
      areas: { ci: { tracker: {}, generated: [{}] } },
    }).get("ci");
    expect(empty).toMatchObject({ globs: [], labels: [], flags: [] });
  });
});

describe("loadCatalogFile", () => {
  it("names the path when the file is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-"));
    try {
      const missing = join(dir, "missing.yaml");
      expect(() => loadCatalogFile(missing)).toThrow(
        `the change-area catalog ${missing} could not be read`,
      );
      const invalid = join(dir, "invalid.yaml");
      writeFileSync(invalid, "areas:\n  ci:\n    paths: 3\n");
      expect(() => loadCatalogFile(invalid)).toThrow(
        `the change-area catalog ${invalid} is not valid: catalog area ci.paths`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("globToRegExp", () => {
  const cases: [string, string, boolean][] = [
    ["src/**", "src/a/b/c.ts", true],
    ["src/**/x.ts", "src/x.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["**/*.md", ".github/README.md", true],
    ["**/schema.json", "schema.json", true],
    ["**/schema.json", "a/b/schema.json", true],
    ["docs/*.md", "docs/index.md", true],
    ["docs/*.md", "docs/guide/index.md", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file/.txt", false],
    ["a/{b,c}/*.ts", "a/c/d.ts", true],
    ["a/{b,c}/*.ts", "a/e/d.ts", false],
    ["a/[xy].ts", "a/y.ts", true],
    ["a/[!xy].ts", "a/y.ts", false],
    ["a/[!xy].ts", "a/z.ts", true],
    ["gen/a[!x]b.ts", "gen/a/b.ts", false],
    ["gen/a[/x]b.ts", "gen/a/b.ts", false],
    ["gen/a[/x]b.ts", "gen/axb.ts", true],
    ["gen/a[^x]b.ts", "gen/a/b.ts", false],
    ["a[]]b", "a]b", true],
    ["a[]]b", "a]]b", false],
    ["a[]x]b", "axb", true],
    ["a[!]]b", "a]b", false],
    ["a[!]]b", "acb", true],
    ["a[!]]b", "a/b", false],
    ["a[!]", "a[!]", true],
    ["gen/a[^]]b.ts", "gen/axb.ts", true],
    ["gen/a[^]]b.ts", "gen/a]b.ts", false],
    ["gen/a[^]]b.ts", "gen/a/b.ts", false],
    ["a[^xy]b", "ayb", false],
    ["a[^xy]b", "azb", true],
    ["a[x^]b", "a^b", true],
    ["a[x^]b", "azb", false],
    ["a[\\x]b", "a\\b", true],
    ["gen/**", "gen/a\nb.ts", true],
    ["**/x.ts", "a\nb/x.ts", true],
    ["a.b", "aXb", false],
    ["a(b)+c", "a(b)+c", true],
    ["a]b", "a]b", true],
    ["a[b", "a[b", true],
    ["a}b,c", "a}b,c", true],
  ];
  for (const [glob, path, matches] of cases)
    it(`${glob} ${matches ? "matches" : "does not match"} ${path}`, () => {
      expect(globToRegExp(glob).test(path)).toBe(matches);
    });
});

describe("globProblem", () => {
  it("says why a glob cannot compile, and nothing for one that can", () => {
    expect(globProblem("src/{a,b}/**")).toBeNull();
    expect(globProblem("src/{a,b")).toContain("unclosed {");
    expect(globProblem("[z-a]")).toContain('"[z-a]" is not a valid glob');
  });
});

describe("areasOf", () => {
  const catalog = parseCatalog({
    areas: {
      api: { paths: ["src/api/**"], generated: [{ source: ["codegen/**"] }] },
      docs: { paths: ["**/*.md"] },
      // Implied areas are not followed: matching is direct.
      contracts: { paths: ["contracts/**"], implied_by: ["api"] },
    },
  });

  it("returns every area whose own globs match, in catalog order", () => {
    expect(areasOf("src/api/README.md", catalog)).toEqual(["api", "docs"]);
    expect(areasOf("codegen/gen.ts", catalog)).toEqual(["api"]);
    expect(areasOf("src/api/x.ts", catalog)).toEqual(["api"]);
    expect(areasOf("other/x.ts", catalog)).toEqual([]);
  });
});
