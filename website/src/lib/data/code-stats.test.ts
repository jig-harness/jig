import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  areaRows,
  commitOf,
  fmtBytes,
  moduleHref,
  moduleParents,
  moduleRows,
  parseCodeStats,
  percent,
  reportOf,
  testToCode,
  topLanguages,
} from "./code-stats.ts";

test("the counting subprocess uses only repository configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "stats-config-"));
  try {
    const scripts = join(root, "plugin/skills/code-stats/scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(
      join(root, ".env"),
      "JIG__CODE_STATS__DEFAULT_AREA=dotenv-area\n",
    );
    writeFileSync(
      join(scripts, "code-stats.ts"),
      "process.stdout.write(JSON.stringify(process.env));",
    );
    const adapter = new URL("./code-stats.ts", import.meta.url).href;
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `import { runCodeStats } from ${JSON.stringify(adapter)}; const r = runCodeStats(${JSON.stringify(root)}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);`,
      ],
      {
        env: {
          ...process.env,
          JIG_USER_LAYER: "on",
          JIG_OVERLAY: "/other.yaml",
          JIG__CODE_STATS__DEFAULT_AREA: "wrong",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(child, 0);
    const env = JSON.parse(child.stdout.toString());
    expect(env.JIG_USER_LAYER).toBe("off");
    expect(env.JIG_OVERLAY).toBe(join(root, ".config/jig.yaml"));
    expect(env.JIG_CONSUMER_ROOT).toBe(root);
    expect(env.JIG__CODE_STATS__DEFAULT_AREA).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const bucket = (code: number, files = 1) => ({
  files,
  bytes: code * 10,
  raw: code + 2 * files,
  code,
  comment: files,
  blank: files,
});

/** A `code-stats/v1` report in the shape the skill prints. */
const FIXTURE = {
  schema: "code-stats/v1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  repository: "shop",
  commit: "abc1234",
  branch: "main",
  totals: {
    files: 6,
    bytes: 1500,
    rawLines: 162,
    codeLines: 150,
    commentLines: 6,
    blankLines: 6,
  },
  unclassified: {
    files: 0,
    codeLines: 0,
    filesShare: 0,
    codeShare: 0,
    kindOther: 0,
    defaultArea: 0,
  },
  vendored: { included: false, excludedFiles: 2, excludedBytes: 300 },
  missingFromWorkingTree: 0,
  testRunners: { configurations: [], unreadable: [] },
  areas: [
    { name: "docs", description: "Documents", default: false },
    { name: "production", description: "The product", default: true },
    { name: "empty", description: "Nothing yet", default: false },
  ],
  byArea: { docs: bucket(20), production: bucket(130, 5) },
  byKind: { code: bucket(80, 3), test: bucket(50, 2), docs: bucket(20) },
  byLanguage: {
    Markdown: bucket(20),
    TypeScript: bucket(120, 2),
    Python: bucket(5),
    Shell: bucket(5),
    "binary (png)": bucket(0),
  },
  byModule: {
    "<root>": bucket(10),
    "lib/a": bucket(100, 3),
    "lib/b": bucket(30),
    docs: bucket(10),
  },
  byAreaKind: {
    "docs/docs": bucket(20),
    "production/code": bucket(80, 3),
    "production/test": bucket(50, 2),
  },
};

const text = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...FIXTURE, ...over });

describe("parseCodeStats", () => {
  test("refuses missing dimensions and inconsistent area-kind relationships", () => {
    for (const dimension of [
      "byArea",
      "byKind",
      "byLanguage",
      "byModule",
      "byAreaKind",
    ]) {
      expect(() => parseCodeStats(text({ [dimension]: {} }))).toThrow();
    }
    expect(() =>
      parseCodeStats(
        text({
          byAreaKind: {
            "docs/code": bucket(20),
            "production/docs": bucket(80, 3),
            "production/test": bucket(50, 2),
          },
        }),
      ),
    ).toThrow();
  });

  test("refuses degraded reports and malformed diagnostics", () => {
    expect(() => parseCodeStats(text({ missingFromWorkingTree: 1 }))).toThrow(
      "missingFromWorkingTree",
    );
    expect(() =>
      parseCodeStats(text({ missingFromWorkingTree: undefined })),
    ).toThrow("missingFromWorkingTree");
    expect(() =>
      parseCodeStats(
        text({
          testRunners: {
            unreadable: [
              {
                reader: "vitest",
                path: "vitest.config.ts",
                why: "invalid config",
              },
            ],
          },
        }),
      ),
    ).toThrow("vitest.config.ts");
    expect(() =>
      parseCodeStats(text({ testRunners: { unreadable: "none" } })),
    ).toThrow("testRunners.unreadable");
  });
  test("reads a code-stats/v1 report", () => {
    const r = parseCodeStats(text());
    expect(r.totals.codeLines).toBe(150);
    expect(r.areas.map((a) => a.name)).toEqual(["docs", "production", "empty"]);
    expect(Object.keys(r.byModule)).toHaveLength(4);
    expect(r.vendored.excludedFiles).toBe(2);
  });

  test("refuses another schema, so the page never renders a shape it does not know", () => {
    expect(() => parseCodeStats(text({ schema: "code-stats/v2" }))).toThrow(
      'schema "code-stats/v2", expected "code-stats/v1"',
    );
    expect(() => parseCodeStats(text({ schema: undefined }))).toThrow(
      "expected",
    );
  });

  test("refuses output that is not JSON", () => {
    expect(() => parseCodeStats("Scanning 3 files…")).toThrow("not JSON");
    expect(() => parseCodeStats("")).toThrow("not JSON");
  });

  test("names the first field that does not fit", () => {
    expect(() =>
      parseCodeStats(
        text({ byModule: { "lib/a": { ...bucket(1), code: "many" } } }),
      ),
    ).toThrow("byModule.lib/a.code is not a count");
    expect(() =>
      parseCodeStats(text({ totals: { ...FIXTURE.totals, files: -1 } })),
    ).toThrow("totals.files is not a count");
    expect(() =>
      parseCodeStats(
        text({ unclassified: { ...FIXTURE.unclassified, codeShare: 2 } }),
      ),
    ).toThrow("unclassified.codeShare");
    expect(() => parseCodeStats(text({ byArea: [] }))).toThrow(
      "byArea is not an object",
    );
  });

  test("refuses an empty report", () => {
    expect(() =>
      parseCodeStats(
        text({ byModule: {}, totals: { ...FIXTURE.totals, files: 0 } }),
      ),
    ).toThrow("counts no files");
  });

  test("refuses a report without exactly one default area", () => {
    expect(() =>
      parseCodeStats(
        text({ areas: FIXTURE.areas.map((a) => ({ ...a, default: false })) }),
      ),
    ).toThrow("no single default area");
  });
});

describe("reportOf", () => {
  test("a run that failed fails the build with what it printed", () => {
    expect(() =>
      reportOf({ status: 1, stdout: "", stderr: "not a git repository" }),
    ).toThrow("exit 1): not a git repository");
    expect(() =>
      reportOf({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("spawn bun ENOENT"),
      }),
    ).toThrow("spawn bun ENOENT");
  });

  test("a run that succeeded gives its report", () => {
    expect(reportOf({ status: 0, stdout: text(), stderr: "" }).repository).toBe(
      "shop",
    );
  });
});

describe("the page's figures", () => {
  const r = parseCodeStats(text());

  test("the test-to-code ratio is the default area's test LOC over its code LOC", () => {
    expect(testToCode(r)).toEqual({
      area: "production",
      code: 80,
      test: 50,
      ratio: 50 / 80,
    });
  });

  test("the areas keep their rule order, and an area with no files counts zero", () => {
    const rows = areaRows(r);
    expect(rows.map((a) => [a.name, a.code, a.codeLoc, a.testLoc])).toEqual([
      ["docs", 20, 0, 0],
      ["production", 130, 80, 50],
      ["empty", 0, 0, 0],
    ]);
  });

  test("the languages are by LOC, the tail summed and binary formats left out", () => {
    const { named, rest } = topLanguages(r, 2);
    expect(named.map((l) => l.name)).toEqual(["TypeScript", "Markdown"]);
    expect(rest).toMatchObject({ languages: 2, code: 10, files: 2 });
    expect(topLanguages(r, 10).rest).toBeNull();
  });

  test("the modules are by LOC, each with the folder that holds it", () => {
    const mods = moduleRows(r);
    expect(mods.map((m) => [m.name, m.parent, m.leaf])).toEqual([
      ["lib/a", "lib", "a"],
      ["lib/b", "lib", "b"],
      ["<root>", "", "<root>"],
      ["docs", "", "docs"],
    ]);
    expect(moduleParents(mods)).toEqual([
      { parent: "lib", modules: 2, code: 130 },
      { parent: "", modules: 2, code: 20 },
    ]);
  });

  test("a skill or a practice module links to its page, any other module to none", () => {
    const pages = {
      skills: new Set(["audit"]),
      modules: new Map([["modules/M2-generated-artifact-freshness", "M2"]]),
    };
    expect(moduleHref("plugin/skills/audit", pages)).toBe("/skills/audit/");
    expect(moduleHref("plugin/skills/unknown", pages)).toBeUndefined();
    expect(moduleHref("plugin/skills/audit/lib", pages)).toBeUndefined();
    expect(moduleHref("modules/M2-generated-artifact-freshness", pages)).toBe(
      "/modules/M2/",
    );
    expect(moduleHref("tools/plugin", pages)).toBeUndefined();
  });

  test("a commit with uncommitted changes is marked, and its hash kept", () => {
    expect(commitOf(r)).toEqual({ sha: "abc1234", dirty: false });
    expect(commitOf(parseCodeStats(text({ commit: "abc1234-dirty" })))).toEqual(
      { sha: "abc1234", dirty: true },
    );
  });

  test("shares and sizes read as the skill writes them", () => {
    expect(percent(0, 10)).toBe("0%");
    expect(percent(1, 10_000)).toBe("<0.1%");
    expect(percent(5, 100)).toBe("5.0%");
    expect(percent(92, 100)).toBe("92%");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(34_543_966)).toBe("32.9 MB");
  });
});
