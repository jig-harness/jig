/**
 * A follow-up's outcome record, one per merged pull request, under
 * `~/.local/state/jig/dispatch/followups/`: written by the tick when the
 * launch record of a follow-up it started ends, done or failed, with that
 * launch record's id. The receipts' retention never removes it, so a launch
 * record that expires after a successful follow-up does not turn it into a
 * failure. An outcome counts only for the marker that names its launch
 * record: a later attempt's outcome replaces it when that attempt ends.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { type ReadRecord, writeWhole } from "./launches.ts";

export interface FollowupOutcome {
  version: 1;
  /** The repository's `owner/name`. */
  repo: string;
  pr: number;
  /** The launch record of the follow-up that ended. */
  record: string;
  outcome: "done" | "failed";
  at: string;
  /** When that launch record was created; absent in a record written before it was kept. */
  created?: string;
}

function outcomesRoot(root: string): string {
  return join(root, "followups");
}

function fileName(repo: string, pr: number): string {
  return `${repo.replace(/[^A-Za-z0-9._-]/g, "__")}-${pr}.json`;
}

function isOutcome(value: unknown): value is FollowupOutcome {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.repo === "string" &&
    typeof value.pr === "number" &&
    typeof value.record === "string" &&
    (value.outcome === "done" || value.outcome === "failed") &&
    typeof value.at === "string" &&
    (value.created === undefined || typeof value.created === "string")
  );
}

/** The outcome files under the root: those of `repo` that read, and the pull requests whose file does not. */
function scanOutcomes(
  repo: string,
  root: string,
): { read: Map<number, FollowupOutcome>; unreadable: Set<number> } {
  const read = new Map<number, FollowupOutcome>();
  const unreadable = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(outcomesRoot(root));
  } catch (error) {
    swallow(error, "no follow-up outcome has been written yet");
    return { read, unreadable };
  }
  const prefix = `${repo.replace(/[^A-Za-z0-9._-]/g, "__")}-`;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // The file name carries the repository and pull request, so a file that does not read still names its pull request.
    const named = name.startsWith(prefix)
      ? /^(\d+)\.json$/.exec(name.slice(prefix.length))
      : null;
    try {
      const value: unknown = JSON.parse(
        readFileSync(join(outcomesRoot(root), name), "utf8"),
      );
      if (isOutcome(value)) {
        if (value.repo === repo) read.set(value.pr, value);
      } else if (named !== null) unreadable.add(Number(named[1]));
    } catch (error) {
      swallow(error, `${name} is not a follow-up outcome`);
      if (named !== null) unreadable.add(Number(named[1]));
    }
  }
  return { read, unreadable };
}

/** The outcome records of `repo`, by pull request; one that does not read is left out (see `unreadableOutcomes`). */
export function readOutcomes(
  repo: string,
  root = stateRoot(),
): Map<number, FollowupOutcome> {
  return scanOutcomes(repo, root).read;
}

/** The pull requests of `repo` whose outcome file exists and does not read: their outcome is unknown, not absent. */
export function unreadableOutcomes(
  repo: string,
  root = stateRoot(),
): Set<number> {
  return scanOutcomes(repo, root).unreadable;
}

/** How an ended follow-up record ended: its session's recorded result, else failed. */
export function outcomeOf(r: ReadRecord): "done" | "failed" | null {
  if (r.state.kind !== "ended" && r.state.kind !== "died") return null;
  return r.result === "done" ? "done" : "failed";
}

/** Whether the written outcome belongs to an attempt later than `record`. */
function supersedes(
  written: FollowupOutcome,
  record: { id: string; createdAt: string },
): boolean {
  const a = Date.parse(written.created ?? "");
  const b = Date.parse(record.createdAt);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return written.record > record.id;
}

/**
 * Write the outcome of every follow-up record among `records` that ended
 * and whose outcome is not yet written, so it outlives the record.
 */
export function settleFollowups(
  records: readonly ReadRecord[],
  root = stateRoot(),
): void {
  const known = new Map<string, Map<number, FollowupOutcome>>();
  for (const r of records) {
    const { record } = r;
    if (record.action !== "followup" || record.pr === null) continue;
    const outcome = outcomeOf(r);
    if (outcome === null) continue;
    let outcomes = known.get(record.repo);
    if (outcomes === undefined) {
      outcomes = readOutcomes(record.repo, root);
      known.set(record.repo, outcomes);
    }
    const written = outcomes.get(record.pr);
    if (written?.record === record.id && written.outcome === outcome) continue;
    // A later attempt's outcome stands over an earlier record that ends after it: ordered by when the record was created, the ids only break a tie (their suffix is random within a second).
    if (written !== undefined && supersedes(written, record)) continue;
    const value: FollowupOutcome = {
      version: 1,
      repo: record.repo,
      pr: record.pr,
      record: record.id,
      outcome,
      at: new Date().toISOString(),
      created: record.createdAt,
    };
    mkdirSync(outcomesRoot(root), { recursive: true, mode: 0o700 });
    writeWhole(
      join(outcomesRoot(root), fileName(record.repo, record.pr)),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    outcomes.set(record.pr, value);
  }
}
