/**
 * The follow-up markers each merged pull request carried when a tick last
 * read them, in the state database's `merge_reads` table (keyed by the
 * repository and the pull request), beside the pull request's `updatedAt`
 * as the merged listing gave it then. A new comment, and an edit of one,
 * moves a pull request's `updatedAt`, so while the listing gives the same
 * `updatedAt` its markers are the ones kept here, and the tick reuses them
 * instead of listing its comments again.
 *
 * A kept read is used only while all of these hold: the listing gives an
 * `updatedAt`, the same one; it is younger than `MERGE_REREAD_MS`, the
 * slow cadence every merge is read again at whatever its `updatedAt` says,
 * since whether deleting a comment moves it is not something the forge
 * documents; and the forge login is the one the read was made as (the `trusted` flags kept
 * with it depend on it); and the pull request has no pending release of a stale claim,
 * whose completion needs a fresh listing (`followup-releases.ts`). A write
 * this tick makes on a pull request (a marker posted, an answer written, a
 * marker deleted, a claim's end written) removes its row
 * (`forgetMergeRead`), so the next tick reads it. A listing that does not
 * read is never kept, and a pull request that leaves the follow-up window
 * loses its row.
 *
 * The same row keeps the launch claims a tick read on a merge where this
 * host's own ended launches still owed their ends (`tick-shared.ts`), under
 * the same rule and the same cadence, timed from their own read, and
 * cleared whenever the markers are read again, since both come from one
 * listing.
 *
 * Keeping these is an optimization, never a record anything else depends
 * on: a row that cannot be read or written is a read the next tick makes.
 */
import { swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import { stateRoot } from "../receipts.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { FollowupMarker, MergedPr } from "./types.ts";

/** How long a kept read stands, whatever the pull request's `updatedAt` says: an hour. */
export const MERGE_REREAD_MS = 60 * 60 * 1000;

/** A merged pull request's markers as a tick last read them. */
export interface MergeRead {
  /** The pull request's `updatedAt` as the listing gave it when the markers were read. */
  updatedAt: string;
  readAtMs: number;
  /**
   * The forge login the reader was signed in as. The `trusted` flags kept
   * with the markers and claims depend on it (the dispatcher's own login is
   * trusted), and a change of login moves no `updatedAt`; `null` where the
   * row predates it.
   */
  login: string | null;
  markers: FollowupMarker[];
  /** The launch claims read on it at the same `updatedAt`, and when; `null` when none are kept. */
  claims: { readAtMs: number; claims: SharedClaim[] } | null;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const optional = (v: unknown, is: (v: unknown) => boolean): boolean =>
  v === undefined || is(v);
const orNull = (v: unknown, is: (v: unknown) => boolean): boolean =>
  v === null || is(v);

/** Whether a stored marker's `run` reads as one of the three shapes of `FollowupMarker`. */
function isMarkerRun(run: unknown): boolean {
  if (!isRecord(run)) return false;
  switch (run.kind) {
    case "tick":
      return (
        isString(run.record) &&
        optional(run.host, isString) &&
        optional(run.owner, isBool) &&
        (run.outcome === undefined ||
          run.outcome === "done" ||
          run.outcome === "failed")
      );
    case "manual":
      return isBool(run.done);
    case "unreadable":
      return isString(run.reason);
    default:
      return false;
  }
}

/** Whether a stored marker reads as one. */
function isMarker(value: unknown): value is FollowupMarker {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    isString(value.login) &&
    isString(value.createdAt) &&
    isBool(value.trusted) &&
    isMarkerRun(value.run)
  );
}

/** Whether a stored launch end reads as one. */
function isEnd(end: unknown): boolean {
  if (!isRecord(end) || !isString(end.at)) return false;
  if (end.state === "died") return isString(end.reason);
  return (
    end.state === "ended" &&
    orNull(end.exit, isNumber) &&
    (end.outcome === null || end.outcome === "done" || end.outcome === "failed")
  );
}

/** Whether a stored claim's content reads as a `ClaimSays`. */
function isSays(v: Record<string, unknown>): boolean {
  return (
    isNumber(v.pr) &&
    isNumber(v.attempt) &&
    isString(v.at) &&
    (v.run === "tick" || v.run === "manual") &&
    (v.action === "rearm" ||
      v.action === "takeover" ||
      v.action === "followup") &&
    orNull(v.record, isString) &&
    orNull(v.host, isString) &&
    orNull(v.owner, isBool) &&
    orNull(v.facts, isString) &&
    orNull(v.change, isString) &&
    optional(
      v.earlier,
      (e) => Array.isArray(e) && e.every((x) => isString(x)),
    ) &&
    isBool(v.conflictStop) &&
    orNull(v.end, isEnd) &&
    isBool(v.legacy)
  );
}

/** Whether a stored launch claim reads as one. */
function isClaim(value: unknown): value is SharedClaim {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    (value.stage === "drive" || value.stage === "followup") &&
    isString(value.login) &&
    isString(value.createdAt) &&
    isBool(value.trusted) &&
    isRecord(value.says) &&
    (value.says.ok === true
      ? isRecord(value.says.value) && isSays(value.says.value)
      : value.says.ok === false &&
        isRecord(value.says.failure) &&
        isString(value.says.failure.code) &&
        isString(value.says.failure.reason))
  );
}

/** A row's stored list; `null` when it does not read, which leaves the pull request to be read again. */
function listOf<T>(text: string, each: (v: unknown) => v is T): T[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every(each) ? value : null;
  } catch (error) {
    swallow(error, "a kept merge read that is not JSON is read again");
    return null;
  }
}

/** A row's kept claims; `null` when none are kept or they do not read. */
function claimsOf(
  text: string | null,
  readAtMs: number | null,
): MergeRead["claims"] {
  if (text === null || readAtMs === null) return null;
  const claims = listOf(text, isClaim);
  return claims === null ? null : { readAtMs, claims };
}

/** The kept reads of `repo`'s merged pull requests, by pull request; none when they cannot be read. */
export function readMergeReads(
  repo: string,
  root = stateRoot(),
): Map<number, MergeRead> {
  const out = new Map<number, MergeRead>();
  try {
    const rows = stateDb(root)
      .query(
        `SELECT pr, updated_at, read_at_ms, login, markers, claims, claims_read_at_ms
         FROM merge_reads WHERE repo = ?`,
      )
      .all(repo) as Array<{
      pr: number;
      updated_at: string;
      read_at_ms: number;
      login: string | null;
      markers: string;
      claims: string | null;
      claims_read_at_ms: number | null;
    }>;
    for (const r of rows) {
      const markers = listOf(r.markers, isMarker);
      if (markers !== null)
        out.set(r.pr, {
          updatedAt: r.updated_at,
          readAtMs: r.read_at_ms,
          login: r.login,
          markers,
          claims: claimsOf(r.claims, r.claims_read_at_ms),
        });
    }
  } catch (error) {
    swallow(error, "a kept merge read that does not read is read again");
  }
  return out;
}

/**
 * Whether a read kept at `readAtMs`, of a pull request at `updatedAt` by the
 * forge login `keptBy`, stands for `pr` this tick, read by `login`: an
 * unknown login on either side never stands, since the kept `trusted` flags
 * cannot be told to hold for it.
 */
function stands(
  updatedAt: string,
  readAtMs: number,
  keptBy: string | null,
  pr: Pick<MergedPr, "updatedAt">,
  login: string | null,
  nowMs: number,
): boolean {
  if (login === null || keptBy !== login) return false;
  if (pr.updatedAt === undefined || updatedAt !== pr.updatedAt) return false;
  const age = nowMs - readAtMs;
  return age >= 0 && age < MERGE_REREAD_MS;
}

/** The markers a kept read gives `pr` this tick; `null` when they are to be read. */
export function keptMarkers(
  kept: MergeRead | undefined,
  pr: Pick<MergedPr, "updatedAt">,
  nowMs: number,
  login: string | null,
): FollowupMarker[] | null {
  return kept !== undefined &&
    stands(kept.updatedAt, kept.readAtMs, kept.login, pr, login, nowMs)
    ? kept.markers
    : null;
}

/** The launch claims a kept read gives `pr` this tick; `null` when they are to be read. */
export function keptClaims(
  kept: MergeRead | undefined,
  pr: Pick<MergedPr, "updatedAt">,
  nowMs: number,
  login: string | null,
): SharedClaim[] | null {
  const claims = kept?.claims ?? null;
  return kept !== undefined &&
    claims !== null &&
    stands(kept.updatedAt, claims.readAtMs, kept.login, pr, login, nowMs)
    ? claims.claims
    : null;
}

/** One merged pull request's markers as this tick read them. */
export interface FreshMergeRead {
  pr: number;
  updatedAt: string;
  markers: FollowupMarker[];
}

/**
 * Keep the markers this tick read, clearing the claims kept beside them,
 * and drop the rows of `repo`'s pull requests the merged listing no longer
 * gives (`listed`).
 */
export function writeMergeReads(
  repo: string,
  fresh: readonly FreshMergeRead[],
  listed: readonly number[],
  nowMs: number,
  login: string | null,
  root = stateRoot(),
): void {
  try {
    const db = stateDb(root);
    inTransaction(db, () => {
      const keep = new Set(listed);
      const stored = db
        .query("SELECT pr FROM merge_reads WHERE repo = ?")
        .all(repo) as Array<{ pr: number }>;
      const drop = db.query(
        "DELETE FROM merge_reads WHERE repo = ? AND pr = ?",
      );
      for (const { pr } of stored) if (!keep.has(pr)) drop.run(repo, pr);
      const put = db.query(
        `INSERT INTO merge_reads (repo, pr, updated_at, read_at_ms, login, markers)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, pr) DO UPDATE SET
           updated_at = excluded.updated_at,
           read_at_ms = excluded.read_at_ms,
           login = excluded.login,
           markers = excluded.markers,
           claims = NULL,
           claims_read_at_ms = NULL`,
      );
      for (const r of fresh)
        put.run(
          repo,
          r.pr,
          r.updatedAt,
          nowMs,
          login,
          JSON.stringify(r.markers),
        );
    });
  } catch (error) {
    swallow(error, "a merge read not kept is read again at the next tick");
  }
}

/** Keep the launch claims this tick read on a merge, beside its markers read at the same `updatedAt`; nothing when no such row is kept. */
export function writeKeptClaims(
  repo: string,
  pr: number,
  updatedAt: string,
  claims: readonly SharedClaim[],
  nowMs: number,
  login: string | null,
  root = stateRoot(),
): void {
  try {
    stateDb(root)
      .query(
        `UPDATE merge_reads SET claims = ?, claims_read_at_ms = ?
         WHERE repo = ? AND pr = ? AND updated_at = ? AND login = ?`,
      )
      .run(JSON.stringify(claims), nowMs, repo, pr, updatedAt, login);
  } catch (error) {
    swallow(error, "launch claims not kept are read again at the next tick");
  }
}

/** Drop a pull request's kept read, after this tick wrote on it. */
export function forgetMergeRead(
  repo: string,
  pr: number,
  root = stateRoot(),
): void {
  try {
    stateDb(root)
      .query("DELETE FROM merge_reads WHERE repo = ? AND pr = ?")
      .run(repo, pr);
  } catch (error) {
    swallow(
      error,
      "a kept read this tick could not drop is read again once its updatedAt moves or it ages past the cadence",
    );
  }
}
