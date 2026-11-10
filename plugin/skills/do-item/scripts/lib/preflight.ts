/**
 * The repository's preflight command, run by every claim before it takes
 * the claim lock or writes anything. It runs once from the repository root
 * with `get_issue.ts`'s JSON for the item on standard input, and answers by
 * its exit code:
 *
 * - 0 proceeds;
 * - 3 refuses, and the first line of its standard output is the reason;
 * - any other exit, a command that cannot start, or one still running past
 *   the deadline is a failed check, which refuses as well.
 *
 * A refusal is a value, never a throw: the caller prints the reason and
 * exits 3 like any other refused claim. Only a setting the command cannot
 * be read from is an error, so a misconfigured repository fails the claim
 * instead of running it unchecked.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { JigError } from "../../../../shared/outcome.ts";
import { readTimeoutEnv, run } from "../../../../shared/proc.ts";
import type { ClaimResult } from "./claim.ts";
import { doItemSection } from "./overlay.ts";

/** The variable that bounds the command, in seconds. */
export const PREFLIGHT_TIMEOUT_ENV = "JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC";
export const DEFAULT_PREFLIGHT_TIMEOUT_SEC = 60;
/** The exit code that refuses with a reason on standard output. */
export const PREFLIGHT_REFUSAL_EXIT = 3;
/** How much of the reason or of a failure's output a refusal keeps. */
const REASON_CHARS = 300;

/** The `do_item` section holds a preflight setting that is not a command. */
export class PreflightConfigError extends JigError<"invalid-preflight-command"> {
  constructor(reason: string) {
    super("invalid-preflight-command", reason);
  }
}

export type PreflightResult =
  | { outcome: "proceed" }
  | {
      outcome: "refused";
      /** `refused`: the command's exit 3; `failed`: any other way it did not answer. */
      kind: "refused" | "failed";
      reason: string;
    };

/**
 * The configured command, `null` when the repository sets none. A value
 * that is not a nonempty string is an error naming the field.
 */
export function preflightCommandOf(
  overlay: Record<string, unknown> | null,
): string | null {
  const section = doItemSection(overlay);
  if (section === undefined || section === null) return null;
  if (!isRecord(section))
    throw new PreflightConfigError("do_item must be a mapping");
  const command = section.preflight_command;
  if (command === undefined || command === null) return null;
  if (typeof command !== "string" || command.trim() === "")
    throw new PreflightConfigError(
      "do_item.preflight_command must be a shell command (nonempty text)",
    );
  return command;
}

/** One line of at most `REASON_CHARS`, with control characters made spaces. */
function oneLine(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS)}…` : line;
}

function failed(reason: string): PreflightResult {
  return { outcome: "refused", kind: "failed", reason };
}

/**
 * Run `command` from `root` with `issueJson` on its standard input and read
 * its answer.
 */
export async function runPreflight(
  root: string,
  command: string,
  issueJson: string,
): Promise<PreflightResult> {
  const timeout = readTimeoutEnv(
    PREFLIGHT_TIMEOUT_ENV,
    DEFAULT_PREFLIGHT_TIMEOUT_SEC,
  );
  if (!timeout.ok)
    return failed(
      `${PREFLIGHT_TIMEOUT_ENV} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(timeout.raw)}, so do_item.preflight_command was not run`,
    );
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  const result = await run(argv, {
    cwd: root,
    stdin: issueJson,
    timeoutSec: timeout.seconds,
  });
  const name = `do_item.preflight_command \`${command}\``;
  if (result.timedOut)
    return failed(
      `${name} was still running after ${timeout.seconds}s and was stopped; ${PREFLIGHT_TIMEOUT_ENV} sets the bound`,
    );
  if (result.spawnFailed)
    return failed(`${name} could not start: ${oneLine(result.stderr)}`);
  if (result.code === 0) return { outcome: "proceed" };
  if (result.code === PREFLIGHT_REFUSAL_EXIT) {
    const first = oneLine(result.stdout.split("\n")[0] ?? "");
    return {
      outcome: "refused",
      kind: "refused",
      reason: first === "" ? `${name} refused it, giving no reason` : first,
    };
  }
  const tail = oneLine(result.stderrTail);
  return failed(
    `${name} failed (exit ${result.code}${tail === "" ? "" : `: ${tail}`})`,
  );
}

/**
 * The refusal a claim of `key` returns when `command` does not let it
 * proceed, `null` when it does. `readIssue` is `get_issue.ts`'s answer for
 * the item. One that is not a found issue (a missing item, an unreachable
 * tracker, an unusable answer) refuses: the command never saw the item, and
 * a later successful read inside the claim must not stand in for it.
 */
export async function preflightClaim(
  root: string,
  command: string,
  key: string,
  readIssue: () => Promise<Record<string, unknown>>,
): Promise<ClaimResult | null> {
  const issue = await readIssue();
  if (issue.found !== true)
    return {
      outcome: "refused",
      issue: key,
      why: "preflight",
      reason: `${key} could not be read for the repository's preflight check, so do_item.preflight_command was not run: ${oneLine(String(issue.error ?? "no reason given"))}`,
    };
  const result = await runPreflight(root, command, JSON.stringify(issue));
  if (result.outcome === "proceed") return null;
  return {
    outcome: "refused",
    issue: key,
    why: "preflight",
    reason: `${key} was refused by the repository's preflight check: ${result.reason}`,
  };
}
