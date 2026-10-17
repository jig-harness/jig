import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { jsonReport, total, unclassified } from "../scripts/lib/aggregate.ts";
import {
  analyzeFile,
  type Context,
  MAX_LINE_COUNT_BYTES,
} from "../scripts/lib/analyze.ts";
import { KINDS, type FileStats } from "../scripts/lib/model.ts";
import {
  encodeReport,
  renderHtmlReport,
  toInlineJson,
} from "../scripts/lib/render-html.ts";
import { DEFAULTS, temporary, write } from "./helpers.ts";

const file = (over: Partial<FileStats>): FileStats => ({
  path: "apps/web/src/a.ts",
  area: "production",
  kind: "code",
  language: "TypeScript",
  module: "apps/web",
  areaMatched: true,
  bytes: 10,
  rawLines: 3,
  blankLines: 1,
  commentLines: 0,
  codeLines: 2,
  ...over,
});

const input = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  repository: "example",
  commit: "abc1234",
  branch: "main",
  areas: ["docs", "production"],
  areaDescriptions: { docs: "Documentation", production: "The rest" },
  defaultArea: "production",
  kinds: KINDS,
  vendoredExcluded: 2,
  includeVendored: false,
  missing: 3,
  conventions: [{ ecosystem: "Go", rule: "*_test.go", kind: "test" }],
  files: [
    file({ areaMatched: false }),
    file({
      path: "docs/</script><b>x.md",
      area: "docs",
      kind: "docs",
      language: "Markdown",
      module: "docs",
    }),
  ],
};

describe("HTML report", () => {
  test("encodes rows against dictionaries, with the fall-through flag", () => {
    const enc = encodeReport(input);
    expect(enc.files).toHaveLength(2);
    const [row] = enc.files;
    if (!row) throw new Error("no row");
    expect(enc.areas[row[1]]).toBe("production");
    expect(enc.kinds[row[2]]).toBe("code");
    expect(enc.languages[row[3]]).toBe("TypeScript");
    expect(enc.modules[row[4]]).toBe("apps/web");
    expect(row.slice(5)).toEqual([10, 3, 2, 0, 1, 1]);
    expect(enc.files[1]?.[10]).toBe(0);
    expect(enc.missingFromWorkingTree).toBe(3);
  });

  test("rejects a value outside the declared dimensions", () => {
    expect(() =>
      encodeReport({ ...input, files: [file({ area: "nope" })] }),
    ).toThrow(/unknown area/);
  });

  test("inline JSON cannot break out of its script element", () => {
    const json = toInlineJson({ p: "</script><!--" });
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual({ p: "</script><!--" });
  });

  test("injects the payload into the real template exactly once", () => {
    const html = renderHtmlReport(input);
    expect(html).not.toContain("__CODE_STATS_DATA__");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    const blob = html
      .split('<script id="code-stats-data" type="application/json">')[1]
      ?.split("</script>")[0];
    const data = JSON.parse(blob ?? "") as { files: unknown[] };
    expect(data.files).toHaveLength(2);
    expect(html).toContain("Unclassified");
  });

  test("fails closed on a template without exactly one placeholder", () => {
    expect(() => renderHtmlReport(input, "<html></html>")).toThrow(
      /placeholder exactly once/,
    );
    const twice = '<p>"__CODE_STATS_DATA__"</p><p>"__CODE_STATS_DATA__"</p>';
    expect(() => renderHtmlReport(input, twice)).toThrow(
      /placeholder exactly once/,
    );
  });
});

describe("aggregates", () => {
  test("the unclassified share counts kind other and default-area fall-through once each", () => {
    const files = [
      file({ areaMatched: false, codeLines: 10 }),
      file({ kind: "other", codeLines: 5 }),
      file({ kind: "other", areaMatched: false, codeLines: 5 }),
      file({ codeLines: 80 }),
    ];
    expect(unclassified(files)).toEqual({
      files: 3,
      codeLines: 20,
      filesShare: 0.75,
      codeShare: 0.2,
      kindOther: 2,
      defaultArea: 2,
    });
  });

  test("the JSON report names its schema and the vendored files left out", () => {
    const report = jsonReport({
      ...input,
      vendoredExcluded: total([file({ kind: "vendored", bytes: 99 })]),
      missing: 0,
    });
    expect(report.schema).toBe("code-stats/v1");
    expect(report.vendored).toEqual({
      included: false,
      excludedFiles: 1,
      excludedBytes: 99,
    });
    expect(Object.keys(report.byArea)).toEqual(["docs", "production"]);
    expect(report.byAreaKind["production/code"]?.files).toBe(1);
    expect(report.unclassified.files).toBe(1);
  });
});

describe("analyzeFile", () => {
  const root = temporary();
  write(root, "dir/big.ts", "const x = 1;\n".repeat(100));
  write(root, "bin/blob.dat", "abc\0def");
  const ctx: Context = {
    root,
    config: DEFAULTS,
    modules: new Map(),
    attributes: new Map(),
    submodules: new Set(),
    overrides: new Map(),
  };

  test.skipIf(process.platform === "win32")(
    "counts a symbolic link as its own entry, sized by the link",
    async () => {
      symlinkSync("dir", join(root, "dir-link"));
      symlinkSync("dir/big.ts", join(root, "file-link"));
      const dirLink = await analyzeFile("dir-link", ctx);
      expect(dirLink?.stats).toMatchObject({
        kind: "other",
        language: "symlink",
        codeLines: 0,
        bytes: "dir".length,
      });
      const fileLink = await analyzeFile("file-link", ctx);
      expect(fileLink?.stats.bytes).toBe("dir/big.ts".length);
    },
  );

  test("reads a regular file, skips a missing one, sizes a binary one", async () => {
    expect((await analyzeFile("dir/big.ts", ctx))?.stats.codeLines).toBe(100);
    expect(await analyzeFile("gone.ts", ctx)).toBeNull();
    expect((await analyzeFile("bin/blob.dat", ctx))?.stats).toMatchObject({
      kind: "asset",
      language: "binary (dat)",
      rawLines: 0,
    });
  });

  test("a file too large to count is still classified from its first bytes", async () => {
    const pad = "x".repeat(MAX_LINE_COUNT_BYTES);
    write(root, "bin/huge", `#!/usr/bin/env python3\n${pad}`);
    write(root, "src/huge.ts", `// @generated by protoc\n${pad}`);
    write(root, "src/huge-blob.ts", `\0${pad}`);
    expect((await analyzeFile("bin/huge", ctx))?.stats).toMatchObject({
      language: "Python",
      kind: "code",
      rawLines: 0,
    });
    expect((await analyzeFile("src/huge.ts", ctx))?.stats.kind).toBe(
      "generated",
    );
    expect((await analyzeFile("src/huge-blob.ts", ctx))?.stats.language).toBe(
      "binary (ts)",
    );
  });

  test("fails loudly on a lookup error other than a missing path", async () => {
    // ENOTDIR: a path component is a regular file.
    await expect(analyzeFile("dir/big.ts/child", ctx)).rejects.toThrow();
  });

  test("a submodule is vendored and not read", async () => {
    write(root, "deps/lib/x.c", "int x;\n");
    const sub = await analyzeFile("deps/lib", {
      ...ctx,
      submodules: new Set(["deps/lib"]),
    });
    expect(sub?.stats).toMatchObject({
      kind: "vendored",
      language: "submodule",
    });
  });
});
