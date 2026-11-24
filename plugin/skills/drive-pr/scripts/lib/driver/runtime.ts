/** Process-lifetime state shared by cancellation, heartbeat callbacks and round phases. */
import type { ProbeStop } from "../status/probe-stop.ts";
import type { RunHandle } from "./../proc.ts";

interface DriverRuntime {
  /** The status probe report this driver stopped on. */
  stopProbe: ProbeStop | null;
  /**
   * What the stop about to be recorded measured of its tree: set by the
   * stall stop from what it reports, and recorded on its `stop` event
   * (`events.ts`). `null` for a stop that measured nothing.
   */
  stopLeftWork: { leftWork: boolean; tree: string } | null;
  /** The reviewer failure the status probe measured on this drive's stop. */
  reviewerFailure: { reviewerHead: string; reviewerApp?: string } | null;
  /**
   * The pages a check-runs listing cut short had read, for the stop that
   * reports it (`CHECK_RUNS_UNREADABLE`); `null` when none was or gh did not
   * say.
   */
  stopListingPages: number | null;
  /** The `finish-round.ts` state every stalled pass ended on, with the last
   * one's reason: set by the stall stop when they all agree
   * (`state/round-finish.ts`), and named by its line and closing report.
   * `null` for any other stop.
   */
  stallFinish: { state: string; reason: string } | null;
  /**
   * When the forge's rate limit resets, for a stop on it
   * (`FORGE_RATE_LIMITED`): recorded on its `stop` event as `until`, which
   * the dispatcher re-drives it after. `null` for any other stop.
   */
  stopLimitedUntil: string | null;
  /**
   * The vendors whose usage-limit scan of the last failed pass was cut short
   * before it found a wall (`DetectOpts.onScanTruncated`); empty when every
   * scan finished, or before a pass failed. A stop on that failure says so
   * in its closing report (`closing-report.ts`), since "no wall found" was
   * then not a finding.
   */
  quotaScanTruncated: string[];
  /** The round loop's waits for the forge's limit to reset since a status probe last read the pull request (`forge-limit-stop.ts`). */
  forgeLimitWaits: number;
  /**
   * The round of the last pass this driver started, review or repair, which
   * every pass reads as `DRIVE_PR_ROUND`; `null` before the first. The
   * closing report reads only the round report stamped with it
   * (`closing-report.ts`).
   */
  passRound: number | null;
  /**
   * When the last pass this driver started began; `null` before the first.
   * A round report written before it belongs to an earlier pass of the same
   * round (a retry, or a repair after a review) and is never read as this
   * pass's conclusion.
   */
  passStartedAt: string | null;
  /**
   * Set when a held lock stops being this process's — named, so the refusal can
   * say which one. Written from the heartbeat timer, read by the round loop.
   */
  compromised: string;

  /**
   * The pass currently running, or `null` between rounds.
   *
   * A pass is the only child that outlives a decision this process can change its
   * mind about. Losing a lock mid-pass and a SIGINT/SIGTERM are both events that
   * must END it, and neither can if nothing holds a handle to it: the loop's
   * `compromised` check runs only at the next round boundary, so a pass that
   * started before the takeover went on to edit, commit and push on behalf of a
   * claim another driver already held.
   */
  activePass: RunHandle | null;

  /**
   * Set while the driver is sleeping out a short quota window — `null`
   * between rounds and whenever a pass is actually running.
   *
   * A quota sleep is the OTHER thing, besides a running pass, that a lock
   * takeover must be able to interrupt promptly rather than let run to
   * completion: `stopActivePass` only has a live pass to act on
   * (`activePass`), so a takeover observed while the driver is merely
   * sleeping through a wall previously went unnoticed until the sleep's OWN
   * up-to-six-hour timer elapsed, holding the compromised lock's refresh
   * going the entire time. `touchLock` aborts this the moment it
   * notices, the same way `stopActivePass` already ends a live pass.
   */
  quotaSleepAbort: AbortController | null;

  /**
   * The witness promise from the stop that is already under way, if any.
   *
   * The takeover path stops the pass from a TIMER callback, which cannot block —
   * so it fires and forgets, and the run loop resolves as soon as the pass
   * process closes. That is earlier than the tree being gone, so without this
   * the loop would return and let the `exit` handler release the lock it still
   * legitimately owns while a descendant lived on. Keeping the promise is what
   * lets the loop re-join the wait it could not perform inline.
   */
  passStopWitness: Promise<boolean> | null;

  driverShuttingDown: boolean;

  driverStopConfirmed: boolean;

  // ── Durable driver log ──────────────────────────────────────────────────────

  /**
   * Install the tee, then announce the log: its path, or why there is none.
   * do-item quotes the announced path as the drive's log, so a log that could
   * not be started is never announced by path.
   */
  /**
   * True while this driver holds the drive's locks; cleared before it releases
   * them. Rotation also stops once another driver has recovered a lock
   * (`compromised`), so only the current owner ever renames the log.
   */
  driverLogRotates: boolean;
}

export const driverRuntime: DriverRuntime = {
  stopProbe: null,
  stopLeftWork: null,
  reviewerFailure: null,
  stopListingPages: null,
  stallFinish: null,
  stopLimitedUntil: null,
  forgeLimitWaits: 0,
  quotaScanTruncated: [],
  passRound: null,
  passStartedAt: null,
  compromised: "",
  activePass: null,
  quotaSleepAbort: null,
  passStopWitness: null,
  driverShuttingDown: false,
  driverStopConfirmed: false,
  driverLogRotates: false,
};
