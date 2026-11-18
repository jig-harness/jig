/**
 * The plugin's one change-area catalog reader: area validation, the tracker
 * block in both spellings and direct path → area matching.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  areasOf,
  loadCatalogFile,
  loadCatalogText,
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

  it("reads serialize, false when absent, and refuses one that is not true or false", () => {
    const catalog = parseCatalog({
      areas: {
        db: { paths: ["db/**"], serialize: true },
        app: { paths: ["src/**"] },
      },
    });
    expect(catalog.get("db")?.serialize).toBe(true);
    expect(catalog.get("app")?.serialize).toBe(false);
    for (const value of ["yes", null, 1])
      expect(() =>
        parseCatalog({ areas: { db: { paths: ["db/**"], serialize: value } } }),
      ).toThrow("catalog area db.serialize: expected true or false");
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

describe("loadCatalogText", () => {
  it("names the label when the text is invalid", () => {
    expect(
      loadCatalogText(
        "areas:\n  ci:\n    paths: [.github/**]\n",
        "x.yaml",
      ).keys(),
    ).toContain("ci");
    expect(() =>
      loadCatalogText("areas:\n  ci:\n    paths: 3\n", "x.yaml"),
    ).toThrow(
      "the change-area catalog x.yaml is not valid: catalog area ci.paths",
    );
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
