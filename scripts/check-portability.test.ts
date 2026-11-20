import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkPortability,
  type PortabilityScope,
  portabilityFindings,
} from "./check-portability.ts";

const root = join(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "tests/fixtures/portability");
const CORE: PortabilityScope = {
  roots: ["plugin/hub/core/"],
  shared: [],
  allowed: [],
};

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A scratch repository holding `files`, outside any git work tree. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-portability-"));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Each finding as `file:line rule`, and the chain of the first. */
function found(dir: string, scope: PortabilityScope = CORE) {
  const read = portabilityFindings(dir, scope);
  if (!read.ok) throw new Error(read.reason);
  return read.findings.map((f) => `${f.file}:${f.line} ${f.rule}`);
}

describe("the negative fixtures each fail", () => {
  test.each([
    ["bun-import", "plugin/hub/core/store.ts:1 portability:runtime-module"],
    ["node-import", "plugin/hub/core/files.ts:1 portability:runtime-module"],
    ["transitive", "plugin/shared/paths.ts:1 portability:runtime-module"],
    ["bare-bun", "plugin/hub/core/files.ts:1 portability:runtime-global"],
    ["bare-process", "plugin/hub/core/env.ts:1 portability:runtime-global"],
    ["bare-deno", "plugin/hub/core/args.ts:1 portability:runtime-global"],
    ["global-alias", "plugin/hub/core/alias.ts:1 portability:runtime-global"],
  ])("%s", (fixture, finding) => {
    const dir = join(fixtures, fixture);
    expect(found(dir)).toEqual([finding]);
    expect(checkPortability(dir, CORE)).toBe(1);
  });

  test("a transitive finding names the chain of imports that reached it", () => {
    const read = portabilityFindings(join(fixtures, "transitive"), CORE);
    if (!read.ok) throw new Error(read.reason);
    expect(read.findings[0]?.chain).toEqual([
      "plugin/hub/core/sync.ts",
      "plugin/shared/paths.ts",
    ]);
    expect(read.findings[0]?.problem).toContain(
      "reached from plugin/hub/core/sync.ts",
    );
  });
});

describe("the positive fixture passes", () => {
  test("type-only imports, names as properties or keys, a declared name, tests", () => {
    const dir = join(fixtures, "pass");
    const read = portabilityFindings(dir, CORE);
    expect(read).toEqual({
      ok: true,
      files: [
        "plugin/hub/core/later.ts",
        "plugin/hub/core/sync.ts",
        "plugin/shared/helper.ts",
      ],
      findings: [],
    });
    expect(checkPortability(dir, CORE)).toBe(0);
  });
});

describe("what else the rules find", () => {
  const core = (source: string, more: Record<string, string> = {}) =>
    found(scratch({ "plugin/hub/core/unit.ts": source, ...more }));

  test("a runtime global through the global object, bracketed or not", () => {
    expect(
      core(`export const a = globalThis.process;
export const b = globalThis["Bun"];
export const c = self.Deno;`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-global",
      "plugin/hub/core/unit.ts:2 portability:runtime-global",
      "plugin/hub/core/unit.ts:3 portability:runtime-global",
    ]);
  });

  test("code a TypeScript enum or namespace runs is read", () => {
    expect(
      core(`export enum E { pid = process.pid }
export namespace N { export const read = () => Bun.file("x"); }
declare namespace D { const x: typeof process }
export enum Fine { a = 1, process = 2 }`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-global",
      "plugin/hub/core/unit.ts:2 portability:runtime-global",
    ]);
  });

  test("a chain of global-object names reaches the same globals", () => {
    expect(
      core(`export const a = globalThis.globalThis.process.env;
export const b = globalThis["globalThis"]["Bun"].file("x");
export const c = globalThis.globalThis;
export const ok = globalThis.setTimeout;`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-global",
      "plugin/hub/core/unit.ts:2 portability:runtime-global",
      "plugin/hub/core/unit.ts:3 portability:runtime-global",
    ]);
  });

  test("import.meta is read only for a fixed portable property", () => {
    expect(
      core(`export const a = import.meta["d" + "ir"];
const meta = import.meta;
export const b = meta.dir;
export const c = import.meta.url;`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-global",
      "plugin/hub/core/unit.ts:2 portability:runtime-global",
    ]);
  });

  test("parameter properties and qualified import aliases run code", () => {
    expect(
      core(`export class C { constructor(public home = process.env.HOME) {} }
import file = Bun.file;
export const read = () => file("x");`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-global",
      "plugin/hub/core/unit.ts:2 portability:runtime-global",
    ]);
  });

  test("an import equals binding named like a runtime global is a declared name", () => {
    expect(
      core(
        `import process = require("../../shared/portable.ts");\nexport const v = process.value;`,
        { "plugin/shared/portable.ts": "export const value = 1;\n" },
      ),
    ).toEqual([]);
  });

  test("a require-form import equals declaration is an import", () => {
    expect(core(`import fs = require("fs");\nexport const x = fs;`)).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-module",
    ]);
  });

  test("a declared runtime global is still the runtime's", () => {
    expect(
      core(`declare const process: { env: Record<string, string> };
export const home = process.env.HOME;`),
    ).toEqual(["plugin/hub/core/unit.ts:2 portability:runtime-global"]);
  });

  test("a bare built-in, bun itself, a package, and the other runtime globals", () => {
    expect(
      core(`import { readFileSync } from "fs";
import { $ } from "bun";
import { z } from "zod";
import { sql } from "drizzle-orm/sql";
export const here = () => [__dirname, require("x"), Buffer.from("a"), import.meta.dir];
export const used = [readFileSync, $, z, sql];`),
    ).toEqual([
      "plugin/hub/core/unit.ts:1 portability:runtime-module",
      "plugin/hub/core/unit.ts:2 portability:runtime-module",
      "plugin/hub/core/unit.ts:3 portability:package-import",
      "plugin/hub/core/unit.ts:4 portability:package-import",
      "plugin/hub/core/unit.ts:5 portability:runtime-global",
      "plugin/hub/core/unit.ts:5 portability:runtime-global",
      "plugin/hub/core/unit.ts:5 portability:runtime-global",
      "plugin/hub/core/unit.ts:5 portability:runtime-global",
    ]);
  });

  test("an allowed package passes", () => {
    const dir = scratch({
      "plugin/hub/core/unit.ts": `import { sql } from "drizzle-orm/sql";\nexport const q = sql;\n`,
    });
    expect(found(dir, { ...CORE, allowed: ["drizzle-orm"] })).toEqual([]);
  });

  test("an allowed vendored bundle's globals pass; its imports and any other vendored file are checked", () => {
    const dir = scratch({
      "plugin/hub/storage/ops.ts": `import { sql } from "../../shared/vendor/orm.mjs";
import { other } from "../../shared/vendor/other.mjs";
export const q = [sql, other];
`,
      "plugin/shared/vendor/orm.mjs": `import { blob } from "./orm-chunk.mjs";
import { readFileSync } from "node:fs";
export const sql = () => (typeof Buffer !== "undefined" ? Buffer.from("a") : blob);
export const read = readFileSync;
`,
      "plugin/shared/vendor/orm-chunk.mjs": `import "bun:sqlite";
export const blob = Buffer.alloc(1);
`,
      "plugin/shared/vendor/other.mjs": `export const other = Buffer.from("b");
`,
    });
    const scope = { ...CORE, roots: ["plugin/hub/storage/"] };
    // The bundle's own Buffer passes; its node:fs import, and its sibling
    // chunk, not listed, are held to every rule.
    expect(
      found(dir, {
        ...scope,
        vendored: ["plugin/shared/vendor/orm.mjs"],
      }),
    ).toEqual([
      "plugin/shared/vendor/orm.mjs:2 portability:runtime-module",
      "plugin/shared/vendor/other.mjs:1 portability:runtime-global",
      "plugin/shared/vendor/orm-chunk.mjs:1 portability:runtime-module",
      "plugin/shared/vendor/orm-chunk.mjs:2 portability:runtime-global",
    ]);
    // Listed too, the chunk's Buffer passes and its bun:sqlite import does not.
    expect(
      found(dir, {
        ...scope,
        vendored: [
          "plugin/shared/vendor/orm.mjs",
          "plugin/shared/vendor/orm-chunk.mjs",
        ],
      }),
    ).toEqual([
      "plugin/shared/vendor/orm.mjs:2 portability:runtime-module",
      "plugin/shared/vendor/other.mjs:1 portability:runtime-global",
      "plugin/shared/vendor/orm-chunk.mjs:1 portability:runtime-module",
    ]);
    expect(found(dir, scope)).toEqual([
      "plugin/shared/vendor/orm.mjs:2 portability:runtime-module",
      "plugin/shared/vendor/orm.mjs:3 portability:runtime-global",
      "plugin/shared/vendor/orm.mjs:3 portability:runtime-global",
      "plugin/shared/vendor/other.mjs:1 portability:runtime-global",
      "plugin/shared/vendor/orm-chunk.mjs:1 portability:runtime-module",
      "plugin/shared/vendor/orm-chunk.mjs:2 portability:runtime-global",
    ]);
  });

  test("an allowed vendored bundle's other runtime globals are still found", () => {
    const dir = scratch({
      "plugin/hub/storage/ops.ts": `import { sql } from "../../shared/vendor/orm.mjs";
export const q = sql;
`,
      "plugin/shared/vendor/orm.mjs": `export const sql = () => Buffer.from("a");
export const cwd = () => process.cwd();
export const run = () => Bun.spawn(["x"]);
export const dir = () => import.meta.dir;
`,
    });
    expect(
      found(dir, {
        ...CORE,
        roots: ["plugin/hub/storage/"],
        vendored: ["plugin/shared/vendor/orm.mjs"],
      }),
    ).toEqual([
      "plugin/shared/vendor/orm.mjs:2 portability:runtime-global",
      "plugin/shared/vendor/orm.mjs:3 portability:runtime-global",
      "plugin/shared/vendor/orm.mjs:4 portability:runtime-global",
    ]);
  });

  test("a dynamic import of a literal is followed; of a computed name, found", () => {
    expect(
      core(
        `export const a = () => import("./later.ts");
export const b = (name: string) => import(name);`,
        { "plugin/hub/core/later.ts": `import "node:os";\n` },
      ),
    ).toEqual([
      "plugin/hub/core/later.ts:1 portability:runtime-module",
      "plugin/hub/core/unit.ts:2 portability:unfollowed-import",
    ]);
  });

  test("an import of a file only a loader reads is found; JSON is not", () => {
    expect(
      core(
        `import schema from "../schema.sql" with { type: "text" };
import shape from "./shape.json" with { type: "json" };
export const both = [schema, shape];`,
        {
          "plugin/hub/schema.sql": "select 1;\n",
          "plugin/hub/core/shape.json": "{}\n",
        },
      ),
    ).toEqual(["plugin/hub/core/unit.ts:1 portability:unfollowed-import"]);
  });

  test("an export from a module is followed, an export of types is not", () => {
    expect(
      core(
        `export { a } from "../../shared/a.ts";
export type { B } from "../../shared/b.ts";`,
        {
          "plugin/shared/a.ts": `export const a = process.argv;\n`,
          "plugin/shared/b.ts": `import "node:fs";\nexport type B = number;\n`,
        },
      ),
    ).toEqual(["plugin/shared/a.ts:1 portability:runtime-global"]);
  });

  test("a shared module declared portable is checked whether the core imports it or not", () => {
    const dir = scratch({
      "plugin/hub/core/unit.ts": "export const unit = 1;\n",
      "plugin/shared/outcome.ts": `import { log } from "./log.ts";\nexport const ok = log;\n`,
      "plugin/shared/log.ts": `export const log = () => process.stderr;\n`,
    });
    expect(
      found(dir, { ...CORE, shared: ["plugin/shared/outcome.ts"] }),
    ).toEqual(["plugin/shared/log.ts:1 portability:runtime-global"]);
  });
});

describe("when it cannot check", () => {
  test("no core, a declared shared module missing, an import of nothing, a file that does not parse", () => {
    expect(checkPortability(scratch({ "README.md": "x\n" }), CORE)).toBe(2);
    expect(
      checkPortability(
        scratch({ "plugin/hub/core/unit.ts": "export const a = 1;\n" }),
        { ...CORE, shared: ["plugin/shared/gone.ts"] },
      ),
    ).toBe(2);
    expect(
      checkPortability(
        scratch({ "plugin/hub/core/unit.ts": `import "./gone.ts";\n` }),
        CORE,
      ),
    ).toBe(2);
    expect(
      checkPortability(
        scratch({ "plugin/hub/core/unit.ts": "export function (\n" }),
        CORE,
      ),
    ).toBe(2);
  });
});

test("passes on this repository, as the gates run it", () => {
  const run = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "check-portability.ts"), root],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(run, 0);
  expect(run.stdout.toString()).toContain("portability: OK");
});
