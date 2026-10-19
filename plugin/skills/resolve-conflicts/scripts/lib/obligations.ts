/** Repository checks applied to the entire resolved staged diff, including clean merges. */
import { fail } from "../../../../shared/cli.ts";
import { readConfig, withSource } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  readTimeoutEnv,
  run,
  type RunResult,
} from "../../../../shared/proc.ts";

export interface ObligationEntry {
  check: string;
  command?: string;
}

export interface ObligationResult {
  check: string;
  command: string | null;
  status: "agent-check" | "passed" | "failed" | "not-run";
  output: string;
}

/** A malformed repository obligation declaration. */
export class ObligationConfigError extends Error {
  override name = "ObligationConfigError";
}

function knownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      throw new ObligationConfigError(
        `${at}.${key} is not a known key (known: ${allowed.join(", ")})`,
      );
}

function requiredText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ObligationConfigError(`${at} must be a nonempty string`);
  return value;
}

function parseEntry(entry: unknown, index: number): ObligationEntry {
  const at = `resolve_conflicts.obligations[${index}]`;
  if (!isRecord(entry))
    throw new ObligationConfigError(
      `${at} must be a mapping with check and optional command`,
    );
  knownKeys(entry, ["check", "command"], at);
  const check = requiredText(entry.check, `${at}.check`);
  if (!Object.hasOwn(entry, "command")) return { check };
  return { check, command: requiredText(entry.command, `${at}.command`) };
}

/** Validate without executing commands, also used by config-fit. */
export function parseObligations(section: unknown): ObligationEntry[] {
  if (section === undefined || section === null) return [];
  if (!isRecord(section))
    throw new ObligationConfigError("resolve_conflicts must be a mapping");
  knownKeys(section, ["generated", "obligations"], "resolve_conflicts");
  const entries = section.obligations;
  if (entries === undefined) return [];
  if (!Array.isArray(entries))
    throw new ObligationConfigError(
      "resolve_conflicts.obligations must be a list",
    );
  return entries.map(parseEntry);
}

/** Read through all consumer configuration layers, with source-aware errors. */
export function obligationEntries(): ObligationEntry[] {
  let values: Record<string, unknown>;
  try {
    values = readConfig();
  } catch (error) {
    fail(
      2,
      `resolve-conflicts: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    return parseObligations(values.resolve_conflicts);
  } catch (error) {
    fail(
      2,
      `resolve-conflicts: ${withSource(values, "resolve_conflicts", error).message}`,
    );
  }
}

/** A successful exit also requires the command's output and descendants to finish. */
function commandFailure(result: RunResult, seconds: number): string | null {
  if (result.timedOut) return `deadline exceeded after ${seconds}s`;
  if (result.groupSurvived) return "command left running descendants";
  if (result.bufferExceeded) return "command output exceeded the capture limit";
  if (result.code !== 0) return `exit ${result.code}`;
  return null;
}

async function runCommand(
  root: string,
  check: string,
  command: string,
  seconds: number,
): Promise<ObligationResult> {
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  const result = await run(argv, {
    cwd: root,
    timeoutSec: seconds,
    reapGroup: true,
  });
  const failure = commandFailure(result, seconds);
  return {
    check,
    command,
    status: failure === null ? "passed" : "failed",
    output: [failure ?? "exit 0", result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Commands complement the agent's inspection of all staged hunks; text is never
 * certified by a command. `stale`, asked before each command, names why the
 * state a command would check is no longer the one the run started from; once
 * it does, that command and every later one are not run.
 */
export async function runObligations(
  root: string,
  entries: readonly ObligationEntry[],
  stale: () => string | null = () => null,
): Promise<ObligationResult[]> {
  const timeout = readTimeoutEnv("RESOLVE_CONFLICTS_COMMAND_TIMEOUT", 120);
  if (!timeout.ok)
    fail(
      2,
      "resolve-conflicts: RESOLVE_CONFLICTS_COMMAND_TIMEOUT must be a positive whole number of seconds no greater than 2147483",
    );
  const results: ObligationResult[] = [];
  let stopped: string | null = null;
  for (const entry of entries) {
    if (entry.command === undefined) {
      results.push({
        check: entry.check,
        command: null,
        status: "agent-check",
        output:
          "Inspect the whole resolved staged diff, including auto-merged hunks.",
      });
      continue;
    }
    stopped ??= stale();
    results.push(
      stopped === null
        ? await runCommand(root, entry.check, entry.command, timeout.seconds)
        : {
            check: entry.check,
            command: entry.command,
            status: "not-run",
            output: stopped,
          },
    );
  }
  return results;
}
