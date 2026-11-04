import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import type {
  NotARecord,
  RecordKind,
} from "../plugin/shared/records/registry.ts";
import {
  findings,
  inScope,
  namedIn,
  opensWithMarker,
  STATE_LIBRARY,
} from "./check-records-registry.ts";

const root = join(import.meta.dir, "..");

/** A template literal's splice of `name`, as source text. */
const splice = (name: string): string => ["$", "{", name, "}"].join("");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A scratch repository holding `files`, outside any git work tree. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "records-registry-"));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function gate(cwdRoot: string, arg?: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "check-records-registry.ts"),
      ...(arg === undefined ? [] : [arg]),
    ],
    { cwd: cwdRoot, stdout: "pipe", stderr: "pipe" },
  );
}

describe("scope", () => {
  test("code under plugin/, never tests, fixtures or vendored code", () => {
    expect(inScope("plugin/dispatch/lib/followup-marker.ts")).toBe(true);
    expect(inScope("plugin/shared/vendor/js-yaml.mjs")).toBe(false);
    expect(inScope("plugin/dispatch/__tests__/followup.test.ts")).toBe(false);
    expect(inScope("plugin/skills/x/fixtures/a.ts")).toBe(false);
    expect(inScope("plugin/skills/drive-pr/SKILL.md")).toBe(false);
    expect(inScope("scripts/check-records-registry.ts")).toBe(false);
  });
});

describe("what the code names", () => {
  const texts = (path: string, text: string) =>
    namedIn(path, text).map((n) => `${n.what} ${n.line} ${n.text}`);

  test("a marker in a string, a template and a regular expression", () => {
    expect(
      texts(
        "plugin/a.ts",
        [
          'const A = "<!-- one-marker -->";',
          `const B = \`<!-- two-marker: ${splice("x")} -->\`;`,
          "const C = /<!--\\s*three-marker:\\s*(\\d+)/;",
          "const D = new RegExp(`<!--\\\\s*four-marker\\\\s*-->`);",
        ].join("\n"),
      ),
    ).toEqual([
      'marker 1 one-marker -->";',
      `marker 2 two-marker: ${splice("x")} -->\`;`,
      "marker 3 three-marker:\\s*(\\d+)/;",
      "marker 4 four-marker\\\\s*-->`);",
    ]);
  });

  test("a spliced name read through the file's string constant, and nothing assembled any other way", () => {
    expect(
      texts(
        "plugin/a.ts",
        [
          'const DATA = "spliced-data";',
          `lines.push(\`<!-- ${splice("DATA")}\`);`,
          `lines.push(\`<!-- ${splice("other")}\`);`,
          `const re = \`<!--\\\\s*${splice('SHA.replace(/x/, "")')}\`;`,
        ].join("\n"),
      ),
    ).toEqual(["marker 2 spliced-data`);"]);
  });

  test("no marker on a comment line, nor `<!--` with no name after it", () => {
    expect(
      texts(
        "plugin/a.ts",
        [
          " * <!-- in-a-doc-comment -->",
          "// <!-- in-a-line-comment -->",
          'if (body.includes("<!--")) return;',
          "const strip = /<!--[\\s\\S]*?-->/g;",
          'const end = "<!-- /closing-marker -->";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a state family only in the drive's state library, and a table anywhere", () => {
    const pattern = '  { re: /^x$/, key: "pr", family: "new-family" },';
    expect(texts("plugin/a.ts", pattern)).toEqual([]);
    expect(texts(`${STATE_LIBRARY}patterns.ts`, pattern)).toEqual([
      "family 1 new-family",
    ]);
    expect(
      texts("plugin/db.ts", "  CREATE TABLE IF NOT EXISTS board_seen ("),
    ).toEqual(["table 1 board_seen"]);
  });

  test("SQL spelling, whitespace and identifier quoting cannot hide a table", () => {
    for (const declaration of [
      "CREATE\nTABLE new_records (id TEXT)",
      "create table new_records (id TEXT)",
      'CREATE TABLE "new_records" (id TEXT)',
      "CREATE TABLE `new_records` (id TEXT)",
      "CREATE TABLE [new_records] (id TEXT)",
      'create\n table if\n not exists "new_records" (id TEXT)',
    ]) {
      const named = namedIn(
        "plugin/db.ts",
        `const sql = \`\n${declaration}\n\`;`,
      );
      expect(named).toEqual([
        { what: "table", text: "new_records", file: "plugin/db.ts", line: 2 },
      ]);
      expect(findings(root, named, [], []).map((f) => f.problem)).toEqual([
        'the table "new_records" is in no registered record kind',
      ]);
    }
  });

  test("a marker matches only where the next character cannot continue its name", () => {
    expect(opensWithMarker("drive-pr-ledger -->", "drive-pr-ledger")).toBe(
      true,
    );
    expect(
      opensWithMarker(
        `drive-pr-merge-ready: ${splice("head")}`,
        "drive-pr-merge-ready",
      ),
    ).toBe(true);
    expect(opensWithMarker("drive-pr-ledger-data", "drive-pr-ledger")).toBe(
      false,
    );
    expect(
      opensWithMarker(
        "coderabbit-ai-generated:v1 -->",
        "coderabbit-ai-generated",
      ),
    ).toBe(false);
  });

  test("SQL trivia and source escapes cannot hide declarations or change locations", () => {
    for (const declaration of [
      "CREATE /* migration */ TABLE new_records (id TEXT)",
      "CREATE TEMP /* migration */ TABLE new_records (id TEXT)",
      "CREATE-- migration\nTABLE new_records (id TEXT)",
      "CREATE\n/* migration */ TABLE new_records (id TEXT)",
      "CREATE /* migration\n * details\n */ TABLE new_records (id TEXT)",
      "CREATE/*a*/TABLE/*b*/IF/*c*/NOT/*d*/EXISTS/*e*/new_records/*f*/(id TEXT)",
      String.raw`CREATE\nTABLE new_records (id TEXT)`,
      String.raw`CREATE\tTABLE\tnew_records (id TEXT)`,
      String.raw`CREATE\x20TABLE new_records (id TEXT)`,
      String.raw`CREATE\u0020TABLE new_records (id TEXT)`,
      String.raw`CREATE\u{20}TABLE new_records (id TEXT)`,
      String.raw`CREATE TABLE \"new_records\" (id TEXT)`,
    ]) {
      const named = namedIn(
        "plugin/db.ts",
        `const before = 1;\nconst sql = \`${declaration}\`;`,
      );
      expect(named).toEqual([
        { what: "table", text: "new_records", file: "plugin/db.ts", line: 2 },
      ]);
      expect(findings(root, named, [], [])).toHaveLength(1);
    }
    expect(
      namedIn("plugin/db.ts", 'CREATE TABLE "a/*literal*/b" (id TEXT)')[0]
        ?.text,
    ).toBe("a/*literal*/b");
    expect(
      namedIn(
        "plugin/db.ts",
        "CREATE /* TABLE fake ( */ TABLE real (id TEXT)",
      ).map((n) => n.text),
    ).toEqual(["real"]);
  });

  test("table headers are accounted for even outside the supported name grammar", () => {
    for (const declaration of [
      'CREATE TABLE "new-records" (id TEXT)',
      "CREATE TEMP TABLE new_records (id TEXT)",
      "CREATE TEMPORARY TABLE new_records (id TEXT)",
      "CREATE VIRTUAL TABLE new_records USING fts5(id)",
      'CREATE TABLE "a""b" (id TEXT)',
      "CREATE TABLE main.new_records (id TEXT)",
      `CREATE TABLE ${splice("tableName")} (id TEXT)`,
    ]) {
      const named = namedIn("plugin/db.ts", declaration);
      expect(named).toHaveLength(1);
      expect(findings(root, named, [], [])).toHaveLength(1);
    }
    expect(
      namedIn("plugin/db.ts", 'CREATE TABLE "new-records" (id TEXT)')[0]?.text,
    ).toBe("new-records");
    expect(
      namedIn("plugin/db.ts", 'CREATE TABLE "a""b" (id TEXT)')[0]?.text,
    ).toBe('a"b');
  });
});

describe("findings", () => {
  const kind: RecordKind = {
    name: "a-record",
    medium: "forge",
    owner: "a.ts",
    at: "a comment",
    markers: ["a-marker"],
    version: 0,
  };
  const banner: NotARecord = { marker: "Generated by", why: "a banner" };
  const dir = scratch({ "plugin/a.ts": "" });

  test("an unregistered marker, named at its file and line", () => {
    const named = namedIn(
      "plugin/a.ts",
      'const A = "<!-- a-marker -->";\nconst B = "<!-- unregistered-marker -->";\nconst C = "<!-- Generated by x -->";',
    );
    const found = findings(dir, named, [kind], [banner]);
    expect(found).toEqual([
      expect.objectContaining({
        rule: "records-registry",
        file: "plugin/a.ts",
        line: 2,
        problem:
          'the hidden marker "unregistered-marker" is in no registered record kind',
      }),
    ]);
  });

  test("an owner must be a regular file contained in plugin", () => {
    for (const owner of [".", "../outside.ts", "a.ts/../..", "absent.ts"]) {
      const dir = scratch({ "plugin/a.ts": "", "outside.ts": "" });
      const found = findings(dir, [], [{ ...kind, markers: [], owner }], []);
      expect(found).toHaveLength(1);
      expect(found[0]?.problem).toContain("owner");
    }
  });

  test("a registry entry the code no longer names, and an owner that is gone", () => {
    const found = findings(
      dir,
      [],
      [{ ...kind, owner: "gone.ts", stateFamily: "old", table: "old_table" }],
      [banner],
    ).map((f) => f.problem);
    expect(found).toEqual([
      'a-record\'s marker "a-marker" is in no code under plugin/',
      `a-record's state family "old" tags no pattern in ${STATE_LIBRARY}`,
      'a-record\'s table "old_table" is created by no code under plugin/',
      expect.stringContaining(
        "a-record's owner plugin/gone.ts cannot be read:",
      ),
      'the marker "Generated by" listed as not a record is in no code under plugin/',
    ]);
  });
});

describe("the gate", () => {
  test("fails for unregistered quoted and temporary tables and unsupported names", () => {
    for (const sql of [
      'CREATE TABLE "new-records" (id TEXT)',
      "CREATE TEMP TABLE new_records (id TEXT)",
      "CREATE TEMPORARY TABLE new_records (id TEXT)",
      "CREATE TABLE main.board_seen (id TEXT)",
      `CREATE TABLE ${splice("tableName")} (id TEXT)`,
      "CREATE /* migration */ TABLE new_records (id TEXT)",
      "CREATE TEMP /* migration */ TABLE new_records (id TEXT)",
      String.raw`CREATE\nTABLE new_records (id TEXT)`,
    ]) {
      const dir = scratch({ "plugin/db.ts": `const sql = \`${sql}\`;` });
      const result = gate(root, dir);
      expectSpawnExit(result, 1);
      expect(result.stderr.toString()).toContain(
        "plugin/db.ts:1: [records-registry]",
      );
    }
  });

  test("passes this repository", () => {
    const r = gate(root);
    expectSpawnExit(r, 0);
    expect(r.stdout.toString()).toContain("records-registry: OK");
  });

  test("fails on an unregistered marker, naming its file and line", () => {
    const dir = scratch({
      "plugin/shared/new.ts":
        '// A record nobody registered.\nexport const MARK = "<!-- jig-unregistered -->";\n',
    });
    const r = gate(root, dir);
    expectSpawnExit(r, 1);
    expect(r.stderr.toString()).toContain(
      'plugin/shared/new.ts:2: [records-registry] the hidden marker "jig-unregistered" is in no registered record kind',
    );
  });

  test("cannot check without a plugin directory", () => {
    expectSpawnExit(gate(root, scratch({ "README.md": "" })), 2);
  });
});
