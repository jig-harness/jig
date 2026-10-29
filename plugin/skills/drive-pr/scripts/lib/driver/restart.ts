/**
 * The stops a drive recovers from without a person: a pass killed at its
 * deadline, and a stall that gets one more round before it stops.
 *
 * A pass killed at its deadline is not rolled back, so the driver runs the
 * two checks the stop used to ask a person to run (uncommitted edits,
 * unpushed commits) and leaves both in the tree for the next pass, which is
 * told what it inherits. A stall gets one more round with the stand-down
 * diagnostics in the pass's notice; the stop that follows names what the
 * passes recorded deciding in the handoff narrative.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  helperTimeoutSeconds,
  run,
  tsArgv,
  unconcludedGitOpMarker,
} from "./../proc.ts";

import { unpushedRange } from "./../driven-branch.ts";

import { handoffPath, NARRATIVE_MARKER } from "./../state/handoff.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { driveState } from "./paths.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { parseJson, recordDriveEvent } from "./rearm.ts";

/**
 * Admit one more pass-deadline restart within `budget`, counting it in the
 * drive state only when it is admitted, so a deadline that stops the drive is
 * never recorded as a restart taken. Returns the restarts taken, with this
 * one when admitted; `null` when the count could not be read or recorded.
 */
export async function admitDeadlineRestart(
  pr: string,
  budget: number,
): Promise<{ admitted: boolean; taken: number } | null> {
  const got = await run(tsArgv(driveState, ["get", pr]), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (got.code !== 0) return null;
  const state = parseJson(got.stdout, "drive-state.ts get");
  if (!isRecord(state)) return null;
  const taken = state.deadlineRetries ?? 0;
  if (typeof taken !== "number" || !Number.isSafeInteger(taken)) return null;
  if (taken >= budget) return { admitted: false, taken };
  const bumped = await bumpDeadlineRetries(pr);
  if (bumped === null) return null;
  await recordDriveEvent(pr, "restart", "pass-deadline");
  return { admitted: true, taken: bumped };
}

/**
 * Count one more pass-deadline restart in the drive state and return the
 * drive's total; `null` when it could not be recorded.
 */
async function bumpDeadlineRetries(pr: string): Promise<number | null> {
  const res = await run(
    tsArgv(driveState, ["deadline-retries", pr, "--set", "bump"]),
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  const n = Number.parseInt(res.stdout.trim(), 10);
  return res.code === 0 && Number.isSafeInteger(n) ? n : null;
}

/**
 * Clear the count once the drive ends (converged, or the PR closed): a later
 * drive of the same PR is a new drive. Best effort; a failure is reported.
 */
export async function clearDeadlineRetries(pr: string): Promise<void> {
  const res = await run(
    tsArgv(driveState, ["deadline-retries", pr, "--set", "clear"]),
    { stdout: "ignore", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (res.code !== 0)
    console.error(
      `drive.ts: could not clear the pass-deadline restart count (drive-state.ts exited ${res.code}).`,
    );
}

/** What a stopped pass left in the driven tree; `null` where a probe failed. */
export interface PassLeftovers {
  /** `git status --short` lines, `''` for a clean tree. */
  uncommitted: string | null;
  /** Commits on the tree's head that the driven branch's remote ref lacks. */
  unpushed: number | null;
  /** An unconcluded merge, rebase or similar, by its marker. */
  operation: string | null;
  /** The tree's HEAD after the kill: the head the next gate may inherit. */
  head: string | null;
}

export async function passLeftovers(): Promise<PassLeftovers> {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  const opts = {
    stderr: "ignore" as const,
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
    ...(anchor ? { cwd: anchor } : {}),
  };
  const status = await git(["status", "--short"], opts);
  const count = await git(["rev-list", "--count", unpushedRange()], opts);
  const unpushed = Number.parseInt(count.stdout.trim(), 10);
  const head = await git(["rev-parse", "HEAD"], opts);
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds(), {
    ...(anchor ? { cwd: anchor } : {}),
    env: gitIdentityEnv(),
  });
  return {
    uncommitted: status.code === 0 ? status.stdout.trimEnd() : null,
    unpushed: count.code === 0 && Number.isFinite(unpushed) ? unpushed : null,
    operation: op.ok ? op.marker : null,
    head:
      head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : null,
  };
}

/**
 * The head the next gate is told the killed pass left work on
 * (`drive-status.ts --inherited-head`): the witnessed HEAD, unless the probes
 * show nothing unpushed and nothing uncommitted. Ahead of the PR head the
 * gate accepts it in place of head lag; on the PR head itself (uncommitted
 * edits only) it still owes the round that settles them, so neither case
 * converges before a pass has run. The gate checks it still is HEAD and
 * descends from the PR head.
 */
export function inheritedHeadOf(l: PassLeftovers): string {
  const leftWork = l.unpushed !== 0 || l.uncommitted !== "";
  return l.head !== null && leftWork ? l.head : "";
}

/** The leftovers as lines for the driver log and the pass notice. */
export function describeLeftovers(l: PassLeftovers): string[] {
  const lines: string[] = [];
  if (l.uncommitted === null)
    lines.push("Uncommitted edits: could not be read (`git status` failed).");
  else if (l.uncommitted === "") lines.push("Uncommitted edits: none.");
  else
    lines.push(
      "Uncommitted edits (git status --short):",
      ...l.uncommitted.split("\n").map((line) => `  ${line}`),
    );
  lines.push(
    l.unpushed === null
      ? `Unpushed commits: could not be counted (${unpushedRange()}).`
      : `Unpushed commits: ${l.unpushed} (${unpushedRange()}).`,
  );
  if (l.operation !== null)
    lines.push(`An unconcluded git operation is open: ${l.operation}.`);
  return lines;
}

/** The notice the pass after a killed one reads in `$DRIVE_PR_PASS_NOTICE`. */
export function deadlineNotice(
  round: number,
  deadlineSec: number,
  leftovers: PassLeftovers,
): string {
  const inherited = inheritedHeadOf(leftovers);
  return [
    `RESTARTED AFTER A PASS DEADLINE: the pass on round ${round} ran past its ${deadlineSec}s deadline and was killed.`,
    "Nothing it did was rolled back. What it left in this tree:",
    ...describeLeftovers(leftovers),
    "Start from that state: finish, validate and push what is sound, discard what is not on purpose, then triage as usual.",
    ...(inherited === ""
      ? []
      : [
          `This pass inherits the killed pass's work at local HEAD ${inherited}. Run the § 1 gate with \`--inherited-head ${inherited}\`: without it the gate reads unpushed commits as HEAD_LAG, and can read a tree with only uncommitted edits as converged. Push what is sound through finish-round like any fix of this round.`,
        ]),
  ].join("\n");
}

/** The notice the extra round after a stall reads in `$DRIVE_PR_PASS_NOTICE`. */
export function stallNotice(diagnostics: string[]): string {
  return [
    "STALLED: the last passes changed nothing this driver can observe. This is the one extra round before the drive stops.",
    ...diagnostics.map((line) => line.trim()),
    "Act on the open work, or, if you decide not to, write one paragraph at the end of the handoff narrative saying what you decided and why: the stop prints it.",
  ].join("\n");
}

/**
 * The last lines the passes wrote under the handoff file's narrative marker:
 * what they recorded deciding. Empty when there is no narrative to read.
 */
export async function recordedDecisions(
  pr: string,
  maxLines = 12,
): Promise<string[]> {
  let text: string;
  try {
    const path = await handoffPath(pr);
    if (!existsSync(path)) return [];
    text = readFileSync(path, "utf8");
  } catch (err) {
    swallow(err, "the handoff file could not be read");
    return [];
  }
  const lines = text.split("\n");
  const at = lines.indexOf(NARRATIVE_MARKER);
  if (at === -1) return [];
  return (
    lines
      .slice(at + 1)
      .map((line) => line.trimEnd())
      // The resume line the handoff writer appends is its own, not a pass's.
      .filter(
        (line) =>
          line.trim() !== "" &&
          !/^\*\*Resume:\*\* `\/drive-pr \d+`$/.test(line),
      )
      .slice(-maxLines)
  );
}
