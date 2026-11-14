/**
 * The drive's helper exits are read from the terminal-state table, as the
 * driver's own exits are: `PUSH_HELD_EXIT` is the table's `PUSH_HELD` entry,
 * declared through `helperExitCode`, and the scripts that exit with it name
 * the constant rather than the number.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_HELD_EXIT } from "../scripts/lib/state/mailbox.ts";
import {
  DRIVE_EXIT,
  helperExitCode,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";

const scripts = join(import.meta.dir, "..", "scripts");
const source = (path: string) => readFileSync(join(scripts, path), "utf8");

/** The lines of `text` outside comments, by a line's first characters. */
const codeLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");

describe("PUSH_HELD", () => {
  test("is a helper exit, which neither drive-status.ts nor drive.ts ends with", () => {
    const entry = TERMINAL_STATES.PUSH_HELD;
    expect(entry?.category).toBe("helper");
    expect(Object.values(DRIVE_EXIT)).not.toContain(entry?.exitCode);
    expect(
      Object.entries(TERMINAL_STATES).filter(
        ([, e]) => e?.exitCode === entry?.exitCode,
      ),
    ).toHaveLength(1);
  });

  test("PUSH_HELD_EXIT is the table's code, declared through helperExitCode", () => {
    expect(PUSH_HELD_EXIT).toBe(helperExitCode("PUSH_HELD"));
    expect(source("lib/state/mailbox.ts")).toMatch(
      /export const PUSH_HELD_EXIT = helperExitCode\("PUSH_HELD"\);/,
    );
  });

  test("the scripts that exit with it name the constant, never the number", () => {
    for (const script of ["guarded-push.ts", "push-hold-recheck.ts"]) {
      const code = codeLines(source(script));
      expect({ script, named: code.includes("PUSH_HELD_EXIT") }).toEqual({
        script,
        named: true,
      });
      expect({ script, bare: /\b17\b/.test(code) }).toEqual({
        script,
        bare: false,
      });
    }
  });
});
