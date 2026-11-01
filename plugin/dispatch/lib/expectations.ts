/**
 * Each launched stage's expectation of how it progresses while it runs,
 * and the stages running outside theirs (**drifting**):
 *
 * - a drive's unresolved review threads fall: each tick records, on the
 *   drive's launch record, the unresolved-thread count at the ledger's
 *   current round the first time it sees that round (`sampleThreads`); the
 *   drive drifts when the count at the latest recorded round is not below
 *   the count `dispatch.drive_rounds_flat` recorded rounds earlier. Rounds
 *   the tick never saw are gaps, not samples;
 * - a pickup opens a pull request within `dispatch.pickup_within` of its
 *   launch;
 * - a follow-up ends within `dispatch.followup_within` of its launch.
 *
 * A drifting stage is reported with the evidence and notified once, keyed
 * by the launch record and the expectation it broke; a session already
 * notified as waiting past `blocked_after` is not notified for drift while
 * that notification stands. Drift is never acted on: the stage keeps
 * running and keeps its slot. Stages the dispatcher did not launch carry no
 * expectation.
 */
import { swallow } from "../../shared/errors.ts";
import {
  isDrive,
  type ReadRecord,
  type ThreadSample,
  targetOf,
  writeRecord,
} from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type {
  Action,
  DispatchSection,
  DrivenPr,
  Evidence,
  Running,
} from "./types.ts";

/** A drive record still running: its wrapper alive. */
function runningDrive(r: ReadRecord): boolean {
  return isDrive(r.record) && r.state.kind === "alive";
}

/**
 * Record, on each running drive's launch record of `repo`, the unresolved
 * thread count at its ledger's current round, the first tick that sees the
 * round. A count that cannot be read leaves a gap.
 */
export async function sampleThreads(
  records: ReadRecord[],
  repo: string,
  drives: DrivenPr[],
  count: (pr: number) => Promise<number>,
  root?: string,
): Promise<void> {
  for (const r of records) {
    const { record } = r;
    if (record.repo !== repo || !runningDrive(r)) continue;
    const round = drives.find((d) => d.number === record.pr)?.evidence.round;
    if (typeof round !== "number") continue;
    const samples = record.samples ?? [];
    if (samples.some((s) => s.round === round)) continue;
    let threads: number;
    try {
      threads = await count(record.pr as number);
    } catch (error) {
      swallow(error, `PR #${record.pr}'s threads at round ${round} are a gap`);
      continue;
    }
    record.samples = [
      ...samples,
      { round, threads, at: new Date().toISOString() },
    ];
    writeRecord(record, root);
  }
}

/**
 * Record, on each running pickup's launch record of `repo`, the first tick
 * that sees a pull request in its workspace: the pull request may close or
 * merge before the pickup ends, and its expectation stays met.
 */
export function observeOpened(
  records: ReadRecord[],
  repo: string,
  sessions: SessionsReport,
  root?: string,
): void {
  for (const r of records) {
    const { record } = r;
    if (
      record.repo !== repo ||
      record.action !== "pickup" ||
      r.state.kind !== "alive" ||
      record.openedAt !== undefined
    )
      continue;
    if ((workspaceOf(r, sessions)?.prs.length ?? 0) === 0) continue;
    record.openedAt = new Date().toISOString();
    writeRecord(record, root);
  }
}

export interface DriftInput {
  slug: string;
  section: DispatchSection;
  launches: ReadRecord[];
  sessions: SessionsReport;
  /** Each item's state as the tracker read it, for a pickup's evidence. */
  itemStates: ReadonlyMap<string, string>;
  /** The launch records a waiting notification is planned for this tick. */
  waiting: ReadonlySet<string>;
  nowMs: number;
}

/** A broken expectation: which, and the evidence. */
interface Broken {
  expectation: string;
  why: string;
  evidence: Evidence;
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

function counts(samples: ThreadSample[]): string {
  return samples.map((s) => `round ${s.round}: ${s.threads}`).join(", ");
}

/** Whether a drive's unresolved threads failed to fall over the window. */
function driveDrift(r: ReadRecord, flat: number): Broken | null {
  const samples = [...(r.record.samples ?? [])].sort(
    (a, b) => a.round - b.round,
  );
  if (samples.length <= flat) return null;
  const latest = samples.at(-1) as ThreadSample;
  const earlier = samples[samples.length - 1 - flat] as ThreadSample;
  if (latest.threads < earlier.threads) return null;
  return {
    expectation: "unresolved threads fall",
    why: `its unresolved threads went from ${earlier.threads} at round ${earlier.round} to ${latest.threads} at round ${latest.round}, not below over ${flat} recorded round(s) (dispatch.drive_rounds_flat)`,
    evidence: { threadsPerRound: counts(samples) },
  };
}

/** The workspace a record runs in, as the runtime reports it; `undefined` when it reports none. */
function workspaceOf(r: ReadRecord, sessions: SessionsReport) {
  if (!sessions.ok || r.record.workspace === null) return undefined;
  const path = r.record.workspace.path;
  return sessions.workspaces.find((w) => w.path === path);
}

/** Whether a pickup or a follow-up has run past its window without what it owes. */
function sessionDrift(r: ReadRecord, input: DriftInput): Broken | null {
  const { record } = r;
  const elapsed = input.nowMs - Date.parse(record.createdAt);
  const since = { sinceLaunch: minutes(elapsed) };
  if (record.action === "followup") {
    const within = input.section.followupWithinMs;
    return elapsed <= within
      ? null
      : {
          expectation: "ends within followup_within",
          why: `it has run ${minutes(elapsed)} without ending (dispatch.followup_within ${minutes(within)})`,
          evidence: since,
        };
  }
  const within = input.section.pickupWithinMs;
  if (elapsed <= within || record.openedAt !== undefined) return null;
  const workspace = workspaceOf(r, input.sessions);
  // An unread runtime cannot say whether the pull request exists.
  if (workspace === undefined || workspace.prs.length > 0) return null;
  return {
    expectation: "opens a pull request within pickup_within",
    why: `it has run ${minutes(elapsed)} and opened no pull request (dispatch.pickup_within ${minutes(within)})`,
    evidence: {
      ...since,
      itemState: input.itemStates.get(record.item ?? "") ?? null,
      workspace: workspace.path,
    },
  };
}

/** The expectation a running record breaks, if any. */
function broken(r: ReadRecord, input: DriftInput): Broken | null {
  if (r.state.kind !== "alive") return null;
  if (isDrive(r.record)) return driveDrift(r, input.section.driveRoundsFlat);
  return sessionDrift(r, input);
}

/**
 * The drifting stages among this machine's running launch records: a
 * notification each, or a line in the report while a waiting notification
 * for the same record stands.
 */
export function planDrift(input: DriftInput): {
  actions: Action[];
  running: Running[];
} {
  const actions: Action[] = [];
  const running: Running[] = [];
  for (const r of input.launches) {
    const found = broken(r, input);
    if (found === null) continue;
    const { record } = r;
    const target = targetOf(record);
    const reason = `drifting: the ${record.action} launched ${record.createdAt} breaks its expectation (${found.expectation}): ${found.why}; never acted on, it keeps running and keeps its slot`;
    const stage = isDrive(record)
      ? "rearm"
      : record.action === "pickup"
        ? "pickup"
        : "followup";
    const evidence = {
      record: record.id,
      stage,
      account: record.account,
      ...found.evidence,
    };
    if (input.waiting.has(record.id)) {
      running.push({
        target,
        stage,
        reason: `${reason}; not notified while its waiting notification stands`,
        evidence,
      });
      continue;
    }
    actions.push({
      stage: "notify",
      target,
      record: "runtime",
      reason,
      evidence,
      cause: "drifting",
      notice: pickupNotice(
        input.slug,
        `${target} drifting, record ${record.id}, expectation ${found.expectation}`,
        `${target}: the ${record.action} session ${reason}`,
      ),
      ...(record.workspace === null
        ? {}
        : { workspace: record.workspace.path }),
    });
  }
  return { actions, running };
}
