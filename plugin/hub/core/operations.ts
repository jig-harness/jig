/**
 * The storage operations the core names
 * ([design/control-plane.md § Concurrency and failures](../../../design/control-plane.md#concurrency-and-failures)):
 * the in-flight read row, the job lease row and the trimming of old rows.
 * Each is declared here by its name, its kind, its input and its result;
 * the storage implementation (`plugin/hub/storage/`) holds the one query
 * behind each, so every adapter runs the same.
 *
 * Times are integer epoch milliseconds the caller reads from its injected
 * clock and passes in: storage reads no clock of its own. A change whose
 * condition does not hold is no failure; its result says it was not
 * applied, and who holds the row instead.
 */
import { operation } from "./storage.ts";

/** A value that survives a round trip through JSON, as a job's progress is stored. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** How long a unit holds a target's in-flight read before another may take it over. */
export const IN_FLIGHT_READ_MS = 30_000;

/** A target's in-flight read: who is reading it through, and until when. */
export interface InFlightRead {
  /** What is read, named by the caller (`pull:owner/name#12`). */
  readonly target: string;
  readonly holder: string;
  readonly takenAt: number;
  readonly deadlineAt: number;
}

/** Whether a take found the row free (or lapsed) and took it, or who holds it. */
export type TakeAnswer =
  | { readonly taken: true; readonly until: number }
  | { readonly taken: false; readonly holder: string; readonly until: number };

/**
 * Takes `target`'s in-flight read for `holder` until `now` plus
 * `IN_FLIGHT_READ_MS`: only when no row is there or its deadline has
 * passed. A unit that finds it held waits for the read's result in
 * storage instead of reading again.
 */
export const takeInFlightRead = operation<
  { target: string; holder: string; now: number },
  TakeAnswer
>("takeInFlightRead", "change");

/** Gives up `target`'s in-flight read, only when `holder` holds it. */
export const releaseInFlightRead = operation<
  { target: string; holder: string },
  { released: boolean }
>("releaseInFlightRead", "change");

/** `target`'s in-flight read, lapsed or not; `null` when no row is there. */
export const readInFlightRead = operation<
  { target: string },
  InFlightRead | null
>("readInFlightRead", "read");

/** A job's lease row: who runs it, until when, and the progress it stored. */
export interface JobLease {
  readonly job: string;
  /** The run that holds the lease; `null` when no run does. */
  readonly holder: string | null;
  readonly leaseUntil: number | null;
  /** What the running or interrupted run stored; `null` when none is owed. */
  readonly progress: JsonValue | null;
  /** When the current or last run took the lease. */
  readonly startedAt: number;
  /** When a run last finished; `null` before the first does. */
  readonly finishedAt: number | null;
  readonly updatedAt: number;
}

/** A taken lease, with the progress an interrupted run left to resume from. */
export type JobLeaseAnswer =
  | {
      readonly taken: true;
      readonly until: number;
      readonly progress: JsonValue | null;
    }
  | { readonly taken: false; readonly holder: string; readonly until: number };

/**
 * Takes `job`'s lease for `holder` until `now` plus `leaseMs`: only when no
 * run holds it, its lease has lapsed, or `holder` already holds it. The
 * progress stays, so the new holder resumes where the last run stopped.
 */
export const takeJobLease = operation<
  { job: string; holder: string; now: number; leaseMs: number },
  JobLeaseAnswer
>("takeJobLease", "change");

/**
 * Stores `progress` for `job` and renews its lease to `now` plus
 * `leaseMs`, only while `holder` holds an unlapsed lease: a run whose
 * lease another run took over learns it here and stops.
 */
export const saveJobProgress = operation<
  {
    job: string;
    holder: string;
    now: number;
    leaseMs: number;
    progress: JsonValue;
  },
  { saved: boolean }
>("saveJobProgress", "change");

/** Ends `holder`'s run of `job`: clears its progress and lease and records when it finished. */
export const finishJob = operation<
  { job: string; holder: string; now: number },
  { finished: boolean }
>("finishJob", "change");

/** `job`'s lease row; `null` before its first run. */
export const readJob = operation<{ job: string }, JobLease | null>(
  "readJob",
  "read",
);

/**
 * Deletes at most `limit` rows of `table` in the partition whose `column`
 * (a time) is before `before`, oldest first; the trimming job calls it
 * until it deletes fewer than `limit`. A table or column no retention rule
 * may trim is refused.
 */
export const trimExpired = operation<
  { table: string; column: string; before: number; limit: number },
  { deleted: number }
>("trimExpired", "change");
