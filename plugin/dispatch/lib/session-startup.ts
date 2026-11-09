/**
 * The follow-ups a tick runs again rather than handing to a person: a
 * headless session that stopped before it could start, retried for as long as
 * it does, and a pass that died during its work with no result and no
 * question, run again once while its death is recent (`retriedDeath`).
 */
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  forEachDirEntry,
  readBoundedTail,
} from "../../skills/drive-pr/scripts/lib/quota/types.ts";
import type { LaunchRecord, ReadRecord } from "./launches.ts";
import { RECOVERY_FACTS } from "./recovery-facts.ts";
import { questionOf } from "./session.ts";
import { swallow } from "../../shared/errors.ts";
import { SESSION_LEASE_MIN } from "../../shared/liveness.ts";

/** Startup failures are limited to the first minute of the vendor process. */
const STARTUP_MS = 60_000;

/**
 * A complete bounded scan must confirm absence. A matching filename proves
 * presence conservatively; content also catches transcripts named differently.
 * Any unreadable file or truncated scan withholds the retry.
 */
function transcriptFiles(configDir: string, deadline: number): string[] | null {
  const files: string[] = [];
  let entries = 0;
  let complete = true;
  const budget = () => {
    if (++entries > 10_000 || Date.now() >= deadline) complete = false;
    return complete;
  };
  const root = join(configDir, "projects");
  const read = forEachDirEntry(root, (entry) => {
    if (!budget()) return false;
    // A link may lead to transcripts this scan does not follow, so it cannot
    // confirm absence.
    if (entry.isSymbolicLink()) {
      complete = false;
      return false;
    }
    if (!entry.isDirectory()) return true;
    const dir = join(root, entry.name);
    if (
      !forEachDirEntry(dir, (file) => {
        if (!budget()) return false;
        if (file.name.endsWith(".jsonl")) files.push(join(dir, file.name));
        return true;
      })
    )
      complete = false;
    return complete;
  });
  return read && complete ? files : null;
}

function transcriptAbsent(record: LaunchRecord, started: number): boolean {
  const session = record.sessionId as string;
  const deadline = Date.now() + 200;
  const files = transcriptFiles(record.configDir, deadline);
  if (files === null) return false;
  try {
    for (const path of files) {
      if (Date.now() >= deadline) return false;
      if (basename(path) === `${session}.jsonl`) return false;
      if (statSync(path).mtimeMs < started) continue;
      // A large file whose beginning is outside the tail cannot prove absence.
      if (statSync(path).size > 256 * 1024) return false;
      if (readBoundedTail(path, 256 * 1024).includes(session)) return false;
    }
    return true;
  } catch (error) {
    swallow(error, "the session's transcript absence could not be confirmed");
    return false;
  }
}

/** Only a recognized standalone vendor notice is persisted, never arbitrary output. */
function quotaNotice(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    const parts = line.trim().split("·");
    if (parts.length !== 2) return false;
    return (
      /^you(?:'|’)ve hit your (?:session |weekly |usage )?limit$/i.test(
        (parts[0] ?? "").trim(),
      ) && /^resets\s+\S/i.test((parts[1] ?? "").trim())
    );
  });
}

export function failedStartup(
  record: LaunchRecord,
  code: number | null,
  started: number,
  output: string,
  exited: number,
): "quota" | "unstarted" | undefined {
  if (
    record.action !== "followup" ||
    record.vendor !== "claude" ||
    typeof record.sessionId !== "string" ||
    code === null ||
    code === 0 ||
    exited - started > STARTUP_MS ||
    !transcriptAbsent(record, started)
  )
    return;
  return quotaNotice(output) ? "quota" : "unstarted";
}

/** Persisted startup evidence permits only the follow-up attempt that never began to retry. */
export function retryableStartup(r: ReadRecord): boolean {
  return (
    r.record.action === "followup" &&
    r.result === null &&
    r.state.kind === "ended" &&
    (r.state.exit.startup === "quota" || r.state.exit.startup === "unstarted")
  );
}

/**
 * Whether a follow-up's session died during its work: its wrapper died, or
 * the pass ended on a signal or a failing exit, with no result recorded and
 * no question stated. One that recorded `failed`, stopped on a question, or
 * exited cleanly without a result is not a death.
 */
export function diedWithoutResult(r: ReadRecord): boolean {
  if (r.record.action !== "followup" || r.result !== null) return false;
  if (retryableStartup(r)) return false;
  if (r.state.kind === "died") return true;
  if (r.state.kind !== "ended") return false;
  const { code, signal } = r.state.exit;
  return (code !== 0 || signal !== null) && questionOf(r.state) === null;
}

/** Whether a follow-up is itself a run again, of one that died or that stopped on a routine question: its failure is a person's. */
export function isRerun(record: Pick<LaunchRecord, "facts">): boolean {
  return record.facts.startsWith(RECOVERY_FACTS);
}

/**
 * How long after its death a follow-up is still the tick's to run again: the
 * session lease (`SESSION_LEASE_MIN`), after which what a session held counts
 * as abandoned. A tick, which runs every few minutes, releases a death's
 * marker well inside it; an older death, a record kept from before deaths
 * were run again among them, keeps the failed follow-up's notice, since a
 * person may already have settled it.
 */
const RETRY_WITHIN_MS = SESSION_LEASE_MIN * 60_000;

/** When a follow-up's record ended: its exit's time, else when its outcome row was timed, else when it was made; `NaN` when none reads. */
function endedAtMs(r: ReadRecord): number {
  if (r.state.kind === "ended") return Date.parse(r.state.exit.at);
  return Date.parse(r.record.endedAt ?? r.record.createdAt);
}

/** A follow-up that died during its work for the first time, within the retry window: its marker is released, and it runs again once. */
export function retriedDeath(r: ReadRecord, nowMs = Date.now()): boolean {
  return (
    diedWithoutResult(r) &&
    !isRerun(r.record) &&
    nowMs - endedAtMs(r) <= RETRY_WITHIN_MS
  );
}

/** Whether a follow-up's end is a retry rather than an outcome: a startup that never began, or a first death. */
export function retryableFollowup(r: ReadRecord): boolean {
  return retryableStartup(r) || retriedDeath(r);
}

/** The ids of retryable follow-ups whose end no later row has settled. */
export function unsettledStartups(
  records: ReadRecord[],
  settled: Set<string>,
): string[] {
  return records
    .filter((r) => retryableFollowup(r) && !settled.has(r.record.id))
    .map((r) => r.record.id);
}
