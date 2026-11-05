/**
 * The dispatcher's part of the terminal-state drift check: a dispatcher file
 * that restates a drive exit as a number, or stops reading the registry,
 * fails `terminal-states-consistency.ts`, and the real files pass.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import {
  closeTypeScriptService,
  createSingleFileProgram,
  resolveLiteral,
} from "./terminal-states-consistency.ts";
import {
  DISPATCH_FILES,
  findDispatchExitLiterals,
  findInlinePairMismatches,
  importsRegistry,
} from "./terminal-states-dispatch.ts";

afterAll(closeTypeScriptService);

const TOOLS = { program: createSingleFileProgram, resolveLiteral };
const PLUGIN = resolve(import.meta.dir, "..", "..", "..");
const CHECK = join(import.meta.dir, "terminal-states-consistency.ts");

const valuesIn = async (source: string) =>
  (await findDispatchExitLiterals(source, "fixture.ts", TOOLS)).map((f) =>
    Number(/exit (\d+)/.exec(f.what)?.[1]),
  );

describe("the dispatcher files as they are", () => {
  test("read every drive exit from the registry", async () => {
    for (const file of DISPATCH_FILES) {
      const source = await Bun.file(join(PLUGIN, file.path)).text();
      expect([
        file.path,
        await importsRegistry(source, file.path, TOOLS),
      ]).toEqual([file.path, file.importsRegistry]);
      expect([
        file.path,
        await findDispatchExitLiterals(source, file.path, TOOLS),
        findInlinePairMismatches(source),
      ]).toEqual([file.path, [], []]);
    }
  });
});

describe("the registry import", () => {
  test("is an import declaration, not a comment or a string", async () => {
    const real = `import { DRIVE_EXIT } from "./terminal-states.ts";\n`;
    const commented = `// import { DRIVE_EXIT } from "./terminal-states.ts";\nconst s = 'from "./terminal-states.ts"';\n`;
    expect(await importsRegistry(real, "a.ts", TOOLS)).toBe(true);
    expect(await importsRegistry(commented, "b.ts", TOOLS)).toBe(false);
  });
});

describe("a restated exit", () => {
  test("is found in each position that classifies an exit", async () => {
    expect(
      await valuesIn(`
const REFUSALS = new Set([11, 13, 20]);
const CLASSES = new Map([[16, "quota wall"], [0, "converged"]]);
const TABLE = { 5: "done", 18: "stopped-by-person" };
const QUOTA = 16;
function f(exit: number, code: number) {
  if (exit === 8) return 1;
  if (code !== QUOTA) return 2;
  switch (exit) { case 9: return 3; }
  return 0;
}
`),
    ).toEqual([11, 13, 20, 16, 0, 5, 18, 8, 16, 9]);
  });

  test("is found through parentheses and a computed key", async () => {
    expect(
      await valuesIn(
        'function f(exit: number) { return (exit) === 8; }\nconst t = { [5]: "done" };\n',
      ),
    ).toEqual([8, 5]);
  });

  test("against a `code` does not count the codes every process exits with; against an `exit` it does", async () => {
    expect(
      await valuesIn(`
function f(done: { code: number }, ledger: { exit: number }) {
  if (done.code !== 0) return 1;
  if (done.code === 2) return 1;
  if (ledger.exit === 0) return 2;
  return 0;
}
`),
    ).toEqual([0]);
  });

  test("read by name from the registry is not one", async () => {
    expect(
      await valuesIn(`
import { DRIVE_EXIT } from "../skills/drive-pr/scripts/lib/status/terminal-states.ts";
const REFUSALS = new Set([DRIVE_EXIT.SINGLE_INSTANCE_LOCK]);
function f(exit: number) { return exit === DRIVE_EXIT.HITL_PARKED; }
`),
    ).toEqual([]);
  });

  test("in prose is checked where it pairs a state with a code", () => {
    expect(
      findInlinePairMismatches(
        `stopped \`QUOTA_PARKED\` (\`${DRIVE_EXIT.QUOTA_PARKED}\`) and \`CONVERGED\` (\`0\`)`,
      ),
    ).toEqual([]);
    expect(
      findInlinePairMismatches(
        "line one\nstopped `QUOTA_PARKED` (`15`), `NO_SUCH_STATE` (`3`)",
      ).map((f) => [f.line, f.what]),
    ).toEqual([
      [2, "`QUOTA_PARKED` (`15`): drive.ts exits 16 for it"],
      [2, "`NO_SUCH_STATE` (`3`) names no state in TERMINAL_STATES"],
    ]);
  });
});

describe("the consistency check over dispatcher files", () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-terminal-dispatch-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const check = (files: string[]) =>
    Bun.spawnSync([process.execPath, CHECK], {
      env: {
        ...process.env,
        DRIVE_PR_TERMINAL_STATES_TEST_DISPATCH_FILES: files.join(delimiter),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("passes a file that reads the registry", () => {
    const clean = fixture(
      "clean.ts",
      `import { DRIVE_EXIT } from "./terminal-states.ts";\nexport const q = (code: number) => code === DRIVE_EXIT.QUOTA_PARKED;\n`,
    );
    expectSpawnExit(check([`${clean}=imports`]), 0);
  });

  test("fails a file that restates an exit, or reads nothing from the registry", () => {
    const restating = fixture(
      "restating.ts",
      `import { DRIVE_EXIT } from "./terminal-states.ts";\nexport const refusals = new Set([11, DRIVE_EXIT.TAKEN_OVER]);\n`,
    );
    const unread = fixture(
      "unread.ts",
      "export const q = (code: number) => code > 0;\n",
    );
    const r = check([`${restating}=imports`, `${unread}=imports`]);
    expectSpawnExit(r, 1);
    const err = r.stderr.toString();
    expect(err).toContain("restating.ts:2  exit 11 in a new Set");
    expect(err).toContain(
      "unread.ts: imports nothing from drive-pr's terminal-states.ts",
    );
  });
});
