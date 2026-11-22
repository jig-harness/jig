/**
 * The copied plugin's run-time imports: every relative one resolves inside
 * the copy, and no Drizzle package is imported where nothing ships it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeWorkingArtifact } from "./artifact.ts";

const root = resolve(import.meta.dirname, "../..");

let scratch: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-imports-")));
  writeWorkingArtifact(root, join(scratch, "artifact"));
  renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The relative specifiers `file` imports at run time (static, side-effect,
 * re-export, dynamic and `require`), as Bun's own parser reads them, so a
 * specifier counts exactly when Bun would load it. That parser erases
 * type-only imports; the compiler checks those in shared code (below). A
 * script's `#!` line, which the scanner rejects, is blanked first.
 */
function runtimeImports(text: string, file: string): string[] {
  const x = file.endsWith("x");
  const loader = /\.(c|m)?jsx?$/.test(file)
    ? x
      ? "jsx"
      : "js"
    : x
      ? "tsx"
      : "ts";
  return new Bun.Transpiler({ loader })
    .scanImports(text.replace(/^#!.*/, ""))
    .map((entry) => entry.path);
}

function relativeImports(text: string, file = "source.ts"): string[] {
  return runtimeImports(text, file).filter((path) => /^\.{1,2}\//.test(path));
}

/** One relative import per line, in every run-time form, with the traps between. */
const SCANNER_SOURCE = [
  'import { a } from "./a.ts";',
  'export { f } from "./f.ts";',
  'export * from "./h.ts";',
  'import "../skills/drive-pr/scripts/drive.ts";',
  'const i = await import("./i.ts");',
  "const j = await import(`../skills/drive-pr/scripts/j.ts`);",
  'const r = require("./r.ts");',
  'let n = 1; const ratio = n++ / 2; await import("./after-division.ts");',
  'import "\\u002e/escaped.ts";',
  "await import(`\\u002e/escaped-template.ts`);",
  'await import(("./parenthesized.ts"));',
  'require(("./parenthesized-require.ts"));',
  "const u = /[\"'`/]{/;\nimport './after-regex.ts';",
  "// import './commented.ts';",
  'const s = "import \\"./in-string.ts\\"";',
  'const y = import.meta.dir; obj.require("./not-y.ts");',
  'import { e } from "node:fs";',
  "a; e; i; j; r; ratio; s; u; y;",
].join("\n");

const SCANNER_FOUND = [
  "./a.ts",
  "./f.ts",
  "./h.ts",
  "../skills/drive-pr/scripts/drive.ts",
  "./i.ts",
  "../skills/drive-pr/scripts/j.ts",
  "./r.ts",
  "./after-division.ts",
  "./escaped.ts",
  "./escaped-template.ts",
  "./parenthesized.ts",
  "./parenthesized-require.ts",
  "./after-regex.ts",
];

test("the import scanner sees every run-time form of relative import", () => {
  expect(relativeImports(SCANNER_SOURCE).toSorted()).toEqual(
    SCANNER_FOUND.toSorted(),
  );
});

test("every relative import in the copied plugin resolves inside the copy", () => {
  // A skill reaches shared code by relative path, so the copy must hold it;
  // shared code never reaches into a skill, so a skill can be removed or
  // renamed without breaking the others.
  const cache = join(scratch, "cache");
  const unresolved: string[] = [];
  const intoSkills: string[] = [];
  const files = readdirSync(cache, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|mts|mjs)$/.test(path))
    .map((path) => join(cache, path));
  expect(files.some((path) => path.startsWith(join(cache, "shared")))).toBe(
    true,
  );
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const path of relativeImports(text, file)) {
      const target = resolve(dirname(file), path);
      const where = `${file.slice(cache.length + 1)} -> ${path}`;
      if (!target.startsWith(cache) || !existsSync(target))
        unresolved.push(where);
      if (
        file.startsWith(join(cache, "shared")) &&
        target.startsWith(join(cache, "skills"))
      )
        intoSkills.push(where);
    }
  }
  expect(unresolved).toEqual([]);
  expect(intoSkills).toEqual([]);
});

/** The Drizzle package specifiers `text` imports at run time. */
const drizzleImports = (text: string, file = "source.ts") =>
  runtimeImports(text, file).filter((path) => /^drizzle-orm(\/|$)/.test(path));

test("the copied plugin imports no Drizzle package at run time", () => {
  // The compile check below declares Drizzle's module names so the vendored
  // declarations resolve; that must not let a run-time import of the unshipped
  // package pass. Each executable extension is read with its own loader.
  const source = 'export { sql } from "drizzle-orm";';
  expect(
    drizzleImports(`${source}\nawait import("drizzle-orm/sqlite-core");`),
  ).toEqual(["drizzle-orm", "drizzle-orm/sqlite-core"]);
  for (const name of ["a.cts", "a.js", "a.cjs", "a.tsx", "a.jsx", "a.mjs"])
    expect(drizzleImports(source, name)).toEqual(["drizzle-orm"]);
  const cache = join(scratch, "cache");
  const offenders = readdirSync(cache, { recursive: true, encoding: "utf8" })
    .filter(
      (path) => /\.(c|m)?(t|j)sx?$/.test(path) && !/\.d\.(c|m)?ts$/.test(path),
    )
    .filter(
      (path) =>
        drizzleImports(readFileSync(join(cache, path), "utf8"), path).length >
        0,
    );
  expect(offenders).toEqual([]);
});
