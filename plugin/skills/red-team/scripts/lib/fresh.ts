/**
 * Each persona as a fresh, non-interactive run of an agent command (for
 * example `claude -p` or `codex exec`), for a harness without subagents. The
 * command gets the persona's prompt as its last argument; whatever it prints
 * is kept as the persona's reply when it wrote no findings file itself.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { run } from "../../../../shared/proc.ts";
import { type Plan, type PlannedPersona, promptFor } from "./plan.ts";

export interface FreshOptions {
  root: string;
  timeoutSec: number;
  parallel: number;
  /** Check and keep one persona's output; the problems, or none. */
  collect: (persona: PlannedPersona) => string[];
}

/**
 * The environment of a run. A run is a new top-level session: the marker
 * Claude Code sets in its own sessions would make `claude` refuse to start
 * as a nested one.
 */
function freshEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

async function one(
  command: string[],
  persona: PlannedPersona,
  options: FreshOptions,
): Promise<string> {
  rmSync(persona.output, { force: true });
  rmSync(persona.reply, { force: true });
  const result = await run([...command, promptFor(persona)], {
    cwd: options.root,
    env: freshEnv(),
    timeoutSec: options.timeoutSec,
    reapGroup: true,
  });
  if (result.spawnFailed) return `could not start ${command[0]}`;
  if (result.timedOut)
    return `still running after ${options.timeoutSec} seconds, stopped`;
  if (result.code !== 0)
    return `exited ${result.code}: ${result.stderrTail.trim().split("\n").pop() ?? ""}`;
  if (!existsSync(persona.output)) writeFileSync(persona.reply, result.stdout);
  const rejected = [persona.output, persona.reply].find((file) =>
    existsSync(file),
  );
  const problems = options.collect(persona);
  if (problems.length === 0) {
    rmSync(persona.feedback, { force: true });
    return "";
  }
  writeFileSync(persona.feedback, feedbackFor(problems, rejected));
  return problems.join("; ");
}

/** What the next attempt reads: the problems, then the output they are about. */
function feedbackFor(problems: string[], rejected: string | undefined): string {
  const lines = [
    "# Your findings were rejected",
    "",
    "Report again, following the brief, and fix each of these:",
    "",
    ...problems.map((problem) => `- ${problem}`),
  ];
  if (rejected)
    lines.push("", "Your rejected output:", "", readFileSync(rejected, "utf8"));
  return `${lines.join("\n")}\n`;
}

/** Run every persona not yet collected, `parallel` at a time. */
export async function runFresh(
  plan: Plan,
  command: string[],
  options: FreshOptions,
): Promise<number> {
  const pending = plan.personas.filter((p) => !existsSync(p.findings));
  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const persona = pending[next++];
      if (!persona) return;
      const problem = await one(command, persona, options);
      if (problem) failures.push(`${persona.id}: ${problem}`);
      console.log(`${persona.id}: ${problem ? "failed" : "collected"}`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.parallel, pending.length) }, worker),
  );
  if (failures.length === 0) return 0;
  console.error("These personas were not collected:");
  for (const failure of failures) console.error(`  - ${failure}`);
  return 1;
}
