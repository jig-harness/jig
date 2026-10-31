/**
 * What this machine's launch records say about one driven pull request,
 * read before the plan wants a re-arm or a takeover for it:
 *
 * - a record that holds its stage (pending, alive, unknown) holds the
 *   pull request: nothing else is launched for it;
 * - a record that ended on a refusal `drive.ts` gives a second driver (`11`,
 *   `13`, `20`), on the same ledger facts as now, is the stage's answer and
 *   is never fought: the pull request is reported, not launched again. A
 *   refusal `16` is the account's wall instead (see walls.ts), which keeps
 *   that account out of admission until its reset;
 * - a `silent` ledger whose driver this machine's record started (the
 *   record was claimed before the ledger's last heartbeat, and did not end
 *   on a refusal) is a takeover of that record, even while the record is
 *   alive: a wedged driver stays alive by definition, and
 *   `drive.ts --take-over` decides whether it is admitted.
 */
import { holds, type ReadRecord } from "../launches.ts";
import type { DrivenPr } from "../types.ts";

/** `drive.ts`'s refusals of a second driver, which end a record without a wall. */
const DRIVER_REFUSALS: ReadonlySet<number> = new Set([11, 13, 20]);

export type DriveHold =
  | { kind: "none" }
  | { kind: "held"; record: ReadRecord; why: string }
  | { kind: "refused"; record: ReadRecord; why: string }
  | { kind: "takeover"; record: ReadRecord };

/** The ledger facts a launch acts on; a refusal on the same facts is final. */
export function factsOf(pr: DrivenPr): string {
  const e = pr.evidence;
  return `generation ${String(e.generation)}, exit ${String(e.exit)}, heartbeat ${String(e.heartbeat)}`;
}

function describe(r: ReadRecord): string {
  const s = r.state;
  const what = `launch record ${r.record.id} (${r.record.action} on ${r.record.account})`;
  if (s.kind === "unknown") return `${what} is unknown: ${s.reason}`;
  if (s.kind === "alive") return `${what} is running, pid ${s.process.pid}`;
  if (s.kind === "pending") {
    const last = r.record.attempts.at(-1);
    return `${what} is pending${last === undefined ? ", its launch not yet answered" : `, its last launch ${last.outcome}: ${last.detail}`}`;
  }
  return what;
}

function refusalOf(r: ReadRecord): number | null {
  if (r.state.kind !== "ended") return null;
  const code = r.state.exit.code;
  return code !== null && DRIVER_REFUSALS.has(code) ? code : null;
}

/** Whether the record started the driver whose heartbeat the ledger shows. */
function startedDriver(r: ReadRecord, heartbeat: string): boolean {
  const s = r.state;
  if (s.kind !== "alive" && s.kind !== "died" && s.kind !== "ended")
    return false;
  if (s.process === null || refusalOf(r) !== null) return false;
  const claimed = Date.parse(s.process.claimedAt);
  const beat = Date.parse(heartbeat);
  return Number.isFinite(claimed) && Number.isFinite(beat) && claimed <= beat;
}

export function driveHold(pr: DrivenPr, records: ReadRecord[]): DriveHold {
  const mine = records
    .filter((r) => r.record.pr === pr.number)
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  if (pr.class === "silent") {
    const takingOver = mine.find(
      (r) => r.record.action === "takeover" && holds(r.state),
    );
    if (takingOver !== undefined)
      return { kind: "held", record: takingOver, why: describe(takingOver) };
    const latest = mine.at(-1);
    return latest !== undefined &&
      startedDriver(latest, String(pr.evidence.heartbeat))
      ? { kind: "takeover", record: latest }
      : { kind: "none" };
  }
  const holding = mine.find((r) => holds(r.state));
  if (holding !== undefined)
    return { kind: "held", record: holding, why: describe(holding) };
  const latest = mine.at(-1);
  const refused = latest === undefined ? null : refusalOf(latest);
  if (
    latest !== undefined &&
    refused !== null &&
    latest.record.facts === factsOf(pr)
  )
    return {
      kind: "refused",
      record: latest,
      why: `launch record ${latest.record.id} ended ${refused}, drive.ts's refusal, on these same ledger facts; it is not launched again until they change`,
    };
  return { kind: "none" };
}
