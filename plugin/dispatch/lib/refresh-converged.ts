/** Refresh a merge-ready drive before planning a re-drive of its new head. */
import {
  helperTimeoutSeconds,
  run,
  type RunResult,
  tsArgv,
} from "../../skills/drive-pr/scripts/lib/proc.ts";
import { LEDGER_NOT_WRITTEN_EXIT } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { ghRepoEnvFor } from "../../shared/gh-repo-env.ts";
import { adoptionOf } from "./adopt.ts";
import { observeBoard } from "./board.ts";
import { holds } from "./launches.ts";
import { canReconcileDriveLedgers } from "./reconcile-drive-ledgers.ts";
import { heldElsewhere } from "./shared-launches.ts";
import { ended, secondsLeft, type TickBound } from "./sources/bounded.ts";
import { readDrives } from "./sources/ledgers.ts";
import { allRecords, tickBound, type TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { DrivenPr } from "./types.ts";

const WAITS = new Map([
  [4, "its clean base merge is waiting for verification on the new head"],
  [
    DRIVE_EXIT.SINGLE_INSTANCE_LOCK,
    "its drive slot is held while the base merge refresh waits",
  ],
  [LEDGER_NOT_WRITTEN_EXIT, "its refreshed ledger could not be confirmed yet"],
]);

function refreshArgs(drive: DrivenPr): string[] | null {
  const { exit, mergeable, headSha, verifiedSha, generation } = drive.evidence;
  if (
    drive.class !== "stale" ||
    exit !== DRIVE_EXIT.CONVERGED ||
    mergeable !== "MERGEABLE" ||
    typeof headSha !== "string" ||
    typeof verifiedSha !== "string" ||
    typeof generation !== "number"
  )
    return null;
  return [String(drive.number), headSha, verifiedSha, String(generation)];
}

function busyPulls(
  context: TickContext,
  observation: RepoObservation,
): Set<number> {
  const busy = heldElsewhere(observation.claims);
  for (const { record, state } of allRecords(context)) {
    if (
      record.repo === observation.opened.repo.slug &&
      record.pr !== null &&
      holds(state)
    )
      busy.add(Number(record.pr));
  }
  return busy;
}

function inScope(
  observation: RepoObservation,
  busy: Set<number>,
  n: number,
): boolean {
  const { forge, held } = observation;
  return (
    !held.has(n) &&
    !busy.has(n) &&
    !forge.disputed.has(n) &&
    (!forge.scoped || forge.inScope.has(n))
  );
}

function reportHelper(
  read: RunResult,
  drive: DrivenPr,
  observation: RepoObservation,
): void {
  const diagnostic = read.stderrTail
    .split("\n")
    .findLast((line) => line.startsWith("base-merge refresh: "));
  if (diagnostic === undefined && (read.code === 0 || read.code === 2)) return;
  const reason =
    diagnostic ??
    (read.timedOut
      ? "the base merge refresh timed out"
      : `the base merge refresh exited ${read.code}`);
  observation.opened.report.unplaced.push({
    target: `PR #${drive.number}`,
    record: "forge",
    reason,
  });
}

async function refreshOne(
  context: TickContext,
  observation: RepoObservation,
  drive: DrivenPr,
  args: string[],
  bound: TickBound | undefined,
): Promise<DrivenPr | undefined> {
  const { opened, forge } = observation;
  const { repo } = opened;
  const pr = forge.open.find((p) => p.number === drive.number);
  if (pr === undefined || pr.isDraft === true) return undefined;

  const result = await run(
    tsArgv(
      `${import.meta.dir}/../../skills/drive-pr/scripts/refresh-base-merge.ts`,
      args,
    ),
    {
      cwd: repo.path,
      env: ghRepoEnvFor(repo.slug),
      timeoutSec: Math.min(
        helperTimeoutSeconds(),
        secondsLeft(bound) ?? Infinity,
      ),
    },
  );
  const waiting = WAITS.get(result.code);
  if (waiting !== undefined) {
    const { stale: _removed, ...tracked } = drive;
    return {
      ...tracked,
      class: "unplaced",
      why: waiting,
      forgeUndecided: true,
    };
  }
  reportHelper(result, drive, observation);
  if (result.code !== 0) return undefined;

  context.reads.comments.forget(repo.slug, drive.number);
  const [fresh] = await readDrives(
    repo.slug,
    forge.login,
    [pr],
    context.nowMs,
    observation.labels,
    adoptionOf(opened.section, forge.login),
    { reviewer: { cwd: repo.path }, ...(bound === undefined ? {} : { bound }) },
  );
  return fresh;
}

export async function refreshConverged(
  context: TickContext,
  observation: RepoObservation,
): Promise<void> {
  if (!canReconcileDriveLedgers(context, observation)) return;
  const { opened, forge, held, drives } = observation;
  const { repo } = opened;
  const bound = tickBound(context);
  const busy = busyPulls(context, observation);
  let refreshed = false;
  for (const [i, drive] of drives.entries()) {
    if (ended(bound)) break;
    if (!inScope(observation, busy, drive.number)) continue;
    const args = refreshArgs(drive);
    if (args === null) continue;
    const placed = await refreshOne(context, observation, drive, args, bound);
    if (placed === undefined) continue;
    drives[i] = placed;
    if (placed.class === "done") refreshed = true;
  }
  if (!refreshed || ended(bound)) return;
  const board = await observeBoard({
    slug: repo.slug,
    checkout: repo.path,
    values: opened.values,
    drives,
    open: forge.open,
    held,
    serialized: observation.serialized,
    budget: context.reads.budget,
    ended: () => ended(bound),
  });
  observation.board = board;
  opened.report.board = board;
}
