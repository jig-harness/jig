/**
 * The repository's preflight command, run by every claim before it takes
 * the claim lock or writes anything. It is a repository's command
 * (`shared/repo-command.ts`): its text is read from `.config/jig.yaml` as
 * the default branch holds it, and it runs from the repository root with a
 * scrubbed environment, a deadline and bounded output. It gets
 * `get_issue.ts`'s JSON for the item on standard input, and answers by its
 * exit code:
 *
 * - 0 proceeds;
 * - 3 refuses, and the first line of its standard output is the reason;
 * - any other exit, a command that cannot start, one still running past the
 *   deadline, or one writing too much output is a failed check, which
 *   refuses as well.
 *
 * A refusal is a value, never a throw: the caller prints the reason and
 * exits 3 like any other refused claim. A setting that is not a command is
 * an error, so a misconfigured repository fails the claim instead of
 * running it unchecked.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { JigError, type Outcome } from "../../../../shared/outcome.ts";
import { readTimeoutEnv } from "../../../../shared/proc.ts";
import {
  defaultBranchSetting,
  oneLine,
  runRepoCommand,
} from "../../../../shared/repo-command.ts";
import type { ClaimResult } from "./claim.ts";
import { doItemSection } from "./overlay.ts";

/** The variable that bounds the command, in seconds. */
export const PREFLIGHT_TIMEOUT_ENV = "JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC";
export const DEFAULT_PREFLIGHT_TIMEOUT_SEC = 60;
/** The exit code that refuses with a reason on standard output. */
export const PREFLIGHT_REFUSAL_EXIT = 3;
const FIELD = "do_item.preflight_command";

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

/** A setting's value as a command; `null` for none, an error for anything else. */
function asCommand(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "")
    throw new PreflightConfigError(
      `${FIELD} must be a shell command (nonempty text)${where}`,
    );
  return value;
}

/**
 * The command a configuration sets, `null` when it sets none. A value
 * that is not a nonempty string is an error naming the field.
 */
export function preflightCommandOf(
  overlay: Record<string, unknown> | null,
): string | null {
  const section = doItemSection(overlay);
  if (section === undefined || section === null) return null;
  if (!isRecord(section))
    throw new PreflightConfigError("do_item must be a mapping");
  return asCommand(section.preflight_command, "");
}

/**
 * The command the claim runs: the default branch's setting. When the
 * default branch cannot be read, a working tree that sets the command
 * refuses the claim (the command it names is not the reviewed one, and
 * running none would skip the repository's rules); one that sets none
 * claims with no check, as before the setting existed.
 */
export async function claimPreflightCommand(
  root: string,
  workingTree: Record<string, unknown> | null,
): Promise<Outcome<string | null, "unreadable">> {
  const read = await defaultBranchSetting(root, "do_item", "preflight_command");
  if (read.ok)
    return {
      ok: true,
      value: asCommand(read.value, ", as the default branch sets it"),
    };
  if (preflightCommandOf(workingTree) === null) return { ok: true, value: null };
  return {
    ok: false,
    failure: {
      code: "unreadable",
      reason: `${FIELD} is read from the default branch, which could not be read: ${read.failure.reason}`,
    },
  };
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
      `${PREFLIGHT_TIMEOUT_ENV} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(timeout.raw)}, so ${FIELD} was not run`,
    );
  const name = `${FIELD} \`${command}\``;
  const result = await runRepoCommand({
    command,
    cwd: root,
    stdin: issueJson,
    timeoutSec: timeout.seconds,
    name,
  });
  if (result.kind === "failed")
    return failed(
      /still running/.test(result.reason)
        ? `${result.reason}; ${PREFLIGHT_TIMEOUT_ENV} sets the bound`
        : result.reason,
    );
  if (result.code === 0) return { outcome: "proceed" };
  if (result.code === PREFLIGHT_REFUSAL_EXIT) {
    const first = oneLine(result.stdout.split("\n")[0] ?? "");
    return {
      outcome: "refused",
      kind: "refused",
      reason: first === "" ? `${name} refused it, giving no reason` : first,
    };
  }
  return failed(
    `${name} failed (exit ${result.code}${result.stderrTail === "" ? "" : `: ${result.stderrTail}`})`,
  );
}

/** The refusal a claim returns: nothing was written. */
function refusal(key: string, reason: string, updatedAt?: unknown): ClaimResult {
  return {
    outcome: "refused",
    issue: key,
    why: "preflight",
    reason,
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
  };
}

/**
 * The refusal a claim of `key` returns when `command` does not let it
 * proceed, `null` when it does. `readIssue` is `get_issue.ts`'s answer for
 * the item. One that is not a found issue (a missing item, an unreachable
 * tracker, an unusable answer) refuses: the command never saw the item, and
 * a later successful read inside the claim must not stand in for it. A
 * refusal carries the item's `updatedAt` as the command saw it, so a
 * dispatcher holds the item until it changes.
 */
export async function preflightClaim(
  root: string,
  command: string,
  key: string,
  readIssue: () => Promise<Record<string, unknown>>,
): Promise<ClaimResult | null> {
  const issue = await readIssue();
  if (issue.found !== true)
    return refusal(
      key,
      `${key} could not be read for the repository's preflight check, so ${FIELD} was not run: ${oneLine(String(issue.error ?? "no reason given"))}`,
    );
  const result = await runPreflight(root, command, JSON.stringify(issue));
  if (result.outcome === "proceed") return null;
  return refusal(
    key,
    `${key} was refused by the repository's preflight check: ${result.reason}`,
    issue.updatedAt,
  );
}

/** The refusal of a claim whose preflight command could not be read. */
export function unreadablePreflight(key: string, reason: string): ClaimResult {
  return refusal(key, `${key} was not claimed: ${reason}`);
}
