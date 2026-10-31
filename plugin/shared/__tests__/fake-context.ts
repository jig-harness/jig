/**
 * A context whose runner answers from a table keyed on the whole argv, so a
 * test pins every argument of every call, and a call the table does not
 * expect fails loudly instead of succeeding by default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Context,
  RunOptions,
  RunResult,
} from "../orca-workspace/runner.ts";

export const ok = (stdout = ""): RunResult => ({
  status: 0,
  stdout,
  stderr: "",
});
export const fail = (status: number, stderr = ""): RunResult => ({
  status,
  stdout: "",
  stderr,
});

/** A value, or answers given in turn (the last one repeats). */
export type Answer = RunResult | RunResult[] | ((argv: string[]) => RunResult);

export interface FakeContext extends Context {
  calls: string[];
  options: (RunOptions | undefined)[];
  lines: string[];
  slept: number[];
}

export function fakeContext(
  table: Record<string, Answer>,
  stateDir = mkdtempSync(join(tmpdir(), "herdr-state-")),
): FakeContext {
  const calls: string[] = [];
  const options: (RunOptions | undefined)[] = [];
  const lines: string[] = [];
  const slept: number[] = [];
  const turn: Record<string, number> = {};
  return {
    calls,
    options,
    lines,
    slept,
    stateDir,
    log: (line) => lines.push(line),
    sleep: (ms) => slept.push(ms),
    run: (argv, runOptions) => {
      const key = argv.join(" ");
      calls.push(key);
      options.push(runOptions);
      const answer = table[key];
      if (answer === undefined) throw new Error(`unexpected command: ${key}`);
      if (typeof answer === "function") return answer(argv);
      if (!Array.isArray(answer)) return answer;
      const at = turn[key] ?? 0;
      turn[key] = at + 1;
      const chosen = answer[Math.min(at, answer.length - 1)];
      if (chosen === undefined) throw new Error(`no answer for: ${key}`);
      return chosen;
    },
  };
}
