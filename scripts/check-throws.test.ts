import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { checkThrows, inScope, throwSites } from "./check-throws.ts";

const root = join(import.meta.dir, "..");

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A scratch repository holding `files`, outside any git work tree. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-throws-"));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const lines = (source: string) => throwSites(source).map((s) => s.line);

describe("scope", () => {
  test("the dispatcher's and resource collection's code, never tests or vendored code", () => {
    expect(inScope("plugin/dispatch/lib/forge.ts")).toBe(true);
    expect(inScope("plugin/gc/kinds/worktrees.ts")).toBe(true);
    expect(inScope("plugin/dispatch/__tests__/tick.test.ts")).toBe(false);
    expect(inScope("plugin/gc/vendor/x.ts")).toBe(false);
    expect(inScope("plugin/shared/proc.ts")).toBe(false);
    expect(inScope("plugin/skills/drive-pr/scripts/drive.ts")).toBe(false);
    expect(inScope("plugin/dispatch/dashboard-page/index.html")).toBe(false);
  });
});

describe("what the rule allows", () => {
  test("a defect, the usage exit and a rethrow of what a catch caught", () => {
    expect(
      lines(`import { Defect } from "./errors.ts";
export function f(x: number): number {
  if (x < 0) throw new Defect("a negative count");
  if (x === 0) throw new ExitError(USAGE_EXIT, "--count must be positive");
  try {
    return g(x);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    try {
      return h(x);
    } catch {
      // An outer catch's binding is still what was caught.
      throw error;
    }
  }
}`),
    ).toEqual([]);
  });

  test("a throw in a comment or a string is no throw", () => {
    expect(
      lines(`// throw new Error("in a comment")
/** Each read throws when it fails. */
const text = "throw new Error('in a string')";
const template = \`throw \${text}\`;`),
    ).toEqual([]);
  });
});

describe("what the rule finds", () => {
  test("any other throw, by its line", () => {
    expect(
      lines(`export function f(x: unknown): void {
  if (x === null) throw new Error("no value");
  if (x === 1) throw new ExitError(2, "a usage error spelled as its number");
  if (x === 2) throw new ExitError(USAGE_EXIT + 1);
  const defect = new Defect("held in a variable");
  if (x === 3) throw defect;
  throw "a string";
}`),
    ).toEqual([2, 3, 4, 6, 7]);
  });

  test("a rethrow of a name the enclosing catch does not bind", () => {
    expect(
      lines(`let saved: unknown;
try {
  run();
} catch (error) {
  saved = error;
}
try {
  run();
} catch (other) {
  throw saved;
}
throw saved;`),
    ).toEqual([10, 12]);
  });

  test("a throw nested in a function or a class inside a catch is still read", () => {
    expect(
      lines(`try {
  run();
} catch (error) {
  later(() => {
    throw new TypeError("deferred");
  });
}`),
    ).toEqual([5]);
  });

  test("source that does not parse is refused rather than read in part", () => {
    expect(() => throwSites("export function (")).toThrow();
  });
});

describe("the gate", () => {
  const CLEAN = `import { Defect } from "../shared/errors.ts";
export function read(x: number): number {
  if (x < 0) throw new Defect("a negative count");
  return x;
}
`;

  test("passes when every throw is allowed", () => {
    const dir = scratch({
      "plugin/dispatch/lib/read.ts": CLEAN,
      "plugin/gc/plan.ts": "export const plan = 1;\n",
      "plugin/dispatch/__tests__/read.test.ts": `throw new Error("tests are out of scope");\n`,
    });
    expect(checkThrows(dir)).toBe(0);
  });

  test("fails with a throw added in the dispatcher or resource collection", () => {
    for (const path of ["plugin/dispatch/lib/read.ts", "plugin/gc/plan.ts"]) {
      const dir = scratch({
        "plugin/dispatch/lib/read.ts": CLEAN,
        "plugin/gc/plan.ts": "export const plan = 1;\n",
      });
      writeFileSync(
        join(dir, path),
        `${CLEAN}export function plan(): never {\n  throw new Error("added");\n}\n`,
      );
      expect(checkThrows(dir)).toBe(1);
    }
  });

  test("cannot check without the directories, or with a file that does not parse", () => {
    expect(checkThrows(scratch({ "README.md": "nothing here\n" }))).toBe(2);
    expect(
      checkThrows(scratch({ "plugin/gc/broken.ts": "export function (\n" })),
    ).toBe(2);
  });

  test("passes on this repository, as the gates run it", () => {
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-throws.ts"), root],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(run, 0);
    expect(run.stdout.toString()).toContain("throws: OK");
  });
});
