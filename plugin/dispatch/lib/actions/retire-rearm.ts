/** Retire requests that can no longer launch, and surface undelivered requests as needs. */
import { listCommentsKept } from "../../../shared/records/comment-pages.ts";
import { KILL_ESCALATE_MS } from "../../../skills/drive-pr/scripts/lib/proc.ts";
import { snapshotFromListing } from "../../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import type { Failure } from "../../../shared/outcome.ts";
import { closedWithLabel, editLabels, pullStateLabels } from "../forge.ts";
import { commandLabel, hasCommand, type LabelConfig } from "../labels.ts";
import {
  latestRearmBinding,
  rearmBinding,
  rearmableStop,
  writeRearmBinding,
} from "../rearm-binding.ts";
import { rearmFailureNotice } from "../notices.ts";
import { readFailureOf } from "../read-failures.ts";
import type {
  DrivenPr,
  Evidence,
  LaunchOutcome,
  RepoReport,
} from "../types.ts";
import { timeLeftMs, type ApplyState } from "./launch.ts";
import { pendingRearm } from "../rearm-state.ts";
import { clearRearmRequest, rearmWaitAge } from "../rearm-waits.ts";

const REARM_WAIT_MS = 30 * 60_000;
const LONG_CAPACITY_WAIT_MS = 4 * 60 * 60_000;

/** Whether an observed structural blocker has outlasted the bound. */
export function rearmBlockExpired(
  state: ApplyState,
  repo: string,
  pr: DrivenPr,
  kind: "tree" | "stop",
  reason: string,
): boolean {
  const request = pr.evidence.rearmRequestId;
  return (
    typeof request === "number" &&
    rearmWaitAge({ repo, pr: pr.number, request, kind }, reason, state.root) >=
      REARM_WAIT_MS
  );
}

/** One capacity entry per waiting request in the line's current capacity view. */
export function reportRearmCapacity(
  state: ApplyState,
  repo: string,
  pr: DrivenPr,
  outcome: LaunchOutcome,
  capacity: "accounts" | "load",
): void {
  const request = pr.evidence.rearmRequestId;
  const load = state.load;
  if (
    load === undefined ||
    typeof request !== "number" ||
    rearmWaitAge(
      { repo, pr: pr.number, request, kind: "capacity" },
      "capacity",
      state.root,
    ) < LONG_CAPACITY_WAIT_MS
  )
    return;
  const detail = `rearm request queued for at least 4 hours: ${outcome.detail}`;
  if (capacity === "load") {
    const existing = load.holds.at(-1);
    if (
      existing?.repo === repo &&
      existing.target === outcome.target &&
      existing.held
    )
      existing.detail = detail;
  } else {
    load.holds.push({
      repo,
      target: outcome.target,
      kind: "drive",
      gauge: "accounts",
      detail,
      held: true,
    });
  }
}

export function failedRearmRequest(
  report: RepoReport,
  slug: string,
  pr: DrivenPr,
  reason: string,
): void {
  report.actions.push({
    stage: "notify",
    cause: "needs-person",
    target: `PR #${pr.number}`,
    record: "forge",
    reason,
    evidence: {
      url: pr.url,
      rearmFailedRequest: pr.evidence.rearmRequestId ?? null,
    },
    notice: rearmFailureNotice(slug, pr, reason),
  });
}

/** An accepted launch still awaiting its label removal is delivered, not a request that could not launch. */
function delivered(state: ApplyState, slug: string, pr: DrivenPr): boolean {
  return state.records.some(
    ({ record, state: launchState }) =>
      record.repo === slug &&
      Number(record.pr) === pr.number &&
      pendingRearm(record, launchState),
  );
}

function retirementReason(
  state: ApplyState,
  slug: string,
  report: RepoReport,
  pr: DrivenPr,
): string | null {
  const { rearmExpired, rearmRequestId, rearm } = pr.evidence;
  if (typeof rearmExpired === "string") {
    const { rearmMovedTo, rearmMovedGeneration } = pr.evidence;
    if (
      typeof rearmMovedTo === "number" &&
      !rearmBlockExpired(
        state,
        slug,
        pr,
        "stop",
        `${rearmMovedTo}/${rearmMovedGeneration}`,
      )
    )
      return null;
    return rearmExpired;
  }
  if (rearm !== true) return null;
  const failure = report.actions.find(
    (a) =>
      a.target === `PR #${pr.number}` &&
      a.evidence.rearmFailedRequest === rearmRequestId &&
      typeof rearmRequestId === "number",
  );
  return delivered(state, slug, pr) ? null : (failure?.reason ?? null);
}

function deadline(state: ApplyState): { timeoutSec?: number } | null {
  const left = timeLeftMs(state);
  if (left === null) return {};
  const timeoutSec = Math.floor((left - KILL_ESCALATE_MS) / 1000);
  return timeoutSec > 0 ? { timeoutSec } : null;
}

interface Retirement {
  state: ApplyState;
  slug: string;
  report: RepoReport;
  label: string;
  login: string | null;
}

function recordFault(run: Retirement, source: string, fault: Failure): void {
  const failure = readFailureOf(fault);
  run.report.records.push({
    record: "forge",
    source,
    ok: false,
    detail: fault.reason,
    ...(failure === undefined ? {} : { failure }),
  });
}

/** End this exact request before removing its shared label. */
async function retire(
  run: Retirement,
  pr: number,
  why: string,
  evidence: Evidence,
): Promise<void> {
  const { state, slug, report, label, login } = run;
  const target = { repo: slug, number: pr };
  const source = `PR #${pr} rearm request`;
  const requestId = evidence.rearmRequestId;
  let room = deadline(state);
  if (room === null) return;
  if (typeof requestId === "number" && evidence.rearmCancelled !== true) {
    const ended = await writeRearmBinding(target, login, label, null, {
      requestId,
      reason: why,
      ...(evidence.rearm === true || evidence.rearmMoved === true
        ? { needsPerson: true }
        : {}),
      ...(typeof evidence.rearmMovedTo === "number" &&
      typeof evidence.rearmMovedGeneration === "number"
        ? {
            failureStop: {
              comment: evidence.rearmMovedTo,
              generation: evidence.rearmMovedGeneration,
            },
          }
        : {}),
      deadline: room,
    });
    if (!ended.ok) {
      recordFault(run, source, ended.failure);
      return;
    }
    room = deadline(state);
    if (room === null) return;
    const comments = await listCommentsKept(target, room);
    if (!comments.ok) {
      recordFault(run, source, comments.failure);
      return;
    }
    if (
      latestRearmBinding(target, login, comments.value, label)?.id !== requestId
    )
      return;
  }
  room = deadline(state);
  if (room === null) return;
  const removed = await editLabels(slug, pr, [], [label], room.timeoutSec);
  if (!removed.ok) {
    recordFault(run, source, removed.failure);
    return;
  }
  report.records.push({
    record: "forge",
    source,
    ok: true,
    detail: `removed ${label}: ${why}`,
  });
  if (typeof requestId === "number")
    clearRearmRequest(slug, pr, requestId, state.root);
}

/** Only the label, request marker, and stopped ledger are needed for retirement. */
async function readRequest(run: Retirement, pr: number, open: boolean) {
  const { state, slug, label, login } = run;
  const source = `PR #${pr} rearm request`;
  const viewRoom = deadline(state);
  if (viewRoom === null) return null;
  const view = await pullStateLabels(slug, pr, viewRoom.timeoutSec);
  if (!view.ok) {
    recordFault(run, source, view.failure);
    return null;
  }
  const { state: prState, labels } = view.value;
  if ((prState === "OPEN") !== open || !labels.includes(label)) return null;
  const commentsRoom = deadline(state);
  if (commentsRoom === null) return null;
  const target = { repo: slug, number: pr };
  const comments = await listCommentsKept(target, commentsRoom);
  if (!comments.ok) {
    recordFault(run, source, comments.failure);
    return null;
  }
  const snapshot = open ? snapshotFromListing(comments.value, login) : null;
  const canonical = snapshot?.canonical;
  if (
    (canonical != null && canonical.parsed.kind !== "ledger") ||
    (canonical == null && (snapshot?.malformed.length ?? 0) > 0)
  ) {
    recordFault(run, source, {
      code: "unreadable",
      reason: "the drive ledger could not be read again",
    });
    return null;
  }
  const stop =
    canonical?.parsed.kind === "ledger" &&
    rearmableStop(canonical.parsed.ledger)
      ? {
          comment: canonical.comment.id,
          generation: canonical.parsed.ledger.generation,
        }
      : null;
  return {
    prState,
    evidence: rearmBinding(target, login, comments.value, label, stop),
  };
}

async function retireClosed(run: Retirement): Promise<void> {
  const room = deadline(run.state);
  if (room === null) return;
  const closed = await closedWithLabel(run.slug, run.label, room.timeoutSec);
  if (!closed.ok) {
    recordFault(run, "closed rearm requests", closed.failure);
    return;
  }
  for (const pr of closed.value) {
    if (deadline(run.state) === null) return;
    const current = await readRequest(run, pr.number, false);
    if (current === null) continue;
    const why =
      current.prState === "MERGED"
        ? "the pull request merged"
        : "the pull request closed";
    await retire(run, pr.number, why, current.evidence);
  }
}

export async function retireRearmRequests(
  state: ApplyState,
  slug: string,
  report: RepoReport,
  labels: LabelConfig,
  observed: readonly DrivenPr[],
  login: string | null,
): Promise<void> {
  const label = commandLabel(labels, "rearm");
  const run = { state, slug, report, label, login };
  for (const pr of observed) {
    if (deadline(state) === null) return;
    if (!pr.labels?.includes(label)) continue;
    const why = retirementReason(state, slug, report, pr);
    if (why === null) continue;
    const current = await readRequest(run, pr.number, true);
    if (
      current === null ||
      current.evidence.rearmRequestId !== pr.evidence.rearmRequestId
    )
      continue;
    const now = { ...pr, evidence: current.evidence };
    if (retirementReason(state, slug, report, now) !== why) continue;
    // Planning withholds a held pull request's notifications, so the notice waits; the binding keeps the failure for after the release.
    const held = hasCommand(labels, pr.labels, "hold");
    if (
      (now.evidence.rearm === true || now.evidence.rearmMoved === true) &&
      !held &&
      !report.actions.some(
        (a) =>
          a.target === `PR #${now.number}` &&
          a.evidence.rearmFailedRequest === now.evidence.rearmRequestId,
      )
    )
      failedRearmRequest(report, slug, now, why);
    await retire(run, pr.number, why, now.evidence);
  }
  await retireClosed(run);
}
