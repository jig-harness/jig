import type { Clock } from "../../../../../shared/clock.ts";
import { definedFields } from "../../../../../shared/defined-fields.ts";
import { DecodeError, isRecord } from "../../../../../shared/guards.ts";
import type { BudgetWindow } from "../../../../../shared/outbound/budget.ts";
import { graphqlPollFloors } from "../../../../../shared/outbound/graph-poll-budget.ts";
import {
  forgeBudgetOn,
  githubBalances,
} from "../../../../../shared/outbound/github-budget.ts";
import { recordCall } from "../../../../../shared/outbound/ledger.ts";
import type { StatusReport } from "./evaluate.ts";

export interface StatusPolling {
  waitingShare: number;
  maxIntervalSeconds: number;
}

export function readStatusPolling(
  config: Record<string, unknown>,
): StatusPolling {
  const policy =
    (isRecord(config.drive) ? config.drive.status_poll : undefined) ?? {};
  if (!isRecord(policy))
    throw new DecodeError("", "drive.status_poll", "must be an object");
  const waitingShare = policy.waiting_share ?? 0.25;
  const maxIntervalSeconds = policy.max_interval_seconds ?? 300;
  if (
    typeof waitingShare !== "number" ||
    !(waitingShare >= 0 && waitingShare <= 1)
  )
    throw new DecodeError(
      "",
      "drive.status_poll.waiting_share",
      "must be a number between 0 and 1",
    );
  if (
    typeof maxIntervalSeconds !== "number" ||
    !Number.isSafeInteger(maxIntervalSeconds) ||
    maxIntervalSeconds < 5 ||
    maxIntervalSeconds > 3600
  )
    throw new DecodeError(
      "",
      "drive.status_poll.max_interval_seconds",
      "must be a whole number between 5 and 3600",
    );
  return { waitingShare, maxIntervalSeconds };
}

export function pollFingerprint(report: StatusReport): string {
  return JSON.stringify([
    report.state,
    report.reason,
    report.apiHead,
    report.localHead,
    report.mergeable,
    report.mergeStateStatus,
    report.baseHead,
    report.isDraft,
    report.ci,
    report.checkProgress,
    report.failingCheckNames,
    report.reviewerPresent,
    report.reviewerStatus,
    report.reviewerConclusion,
    report.reviewedSha,
    report.openThreadKeys,
    report.openThreadVersions,
    report.parkedItemKeys,
    report.summaryUnaddressedKeys,
  ]);
}

interface BalanceSample {
  windows: BudgetWindow[];
  credential?: string;
}

function readBalance(now: number): BalanceSample {
  const balances = forgeBudgetOn() ? githubBalances() : null;
  if (balances === null) return { windows: [] };
  return {
    windows: [balances.graphql, ...graphqlPollFloors(balances.windows, now)],
    ...definedFields({ credential: balances.credential }),
  };
}

interface Dependencies extends Clock {
  balance(): BalanceSample;
  record(credential: string | undefined, ms: number, skipped: number): void;
}

export function pollDependencies(clock: Clock): Dependencies {
  return {
    ...clock,
    balance: () => readBalance(clock.now()),
    record(credential, durationMs, skipped) {
      const entry = {
        system: "github",
        credential: credential ?? "(unavailable)",
        owner: credential ?? null,
        window: "none",
        unit: "polls",
        requests: 0,
      };
      recordCall({
        ...entry,
        operation: "drive-status poll wait",
        cost: 1,
        durationMs,
      });
      if (skipped > 0)
        recordCall({
          ...entry,
          operation: "drive-status poll skipped",
          cost: skipped,
          durationMs: 0,
        });
    },
  };
}

function remainingFraction(window: BudgetWindow): number | null {
  if (window.limit === null || window.limit <= 0 || window.remaining === null)
    return null;
  return window.remaining / window.limit;
}

/** Whether `other` leaves no more than `window` on the same reset. */
function leavesNoMore(other: BudgetWindow, window: BudgetWindow): boolean {
  return (
    other.resetAt === window.resetAt &&
    other.remaining !== null &&
    window.remaining !== null &&
    other.remaining <= window.remaining
  );
}

/** Whether `other` enforces the same reset at least as strictly as `window`. */
function enforcesMoreStrictly(
  other: BudgetWindow,
  otherIndex: number,
  window: BudgetWindow,
  index: number,
): boolean {
  if (otherIndex === index || !leavesNoMore(other, window)) return false;
  const fraction = remainingFraction(window);
  const otherFraction = remainingFraction(other);
  if (fraction !== null && (otherFraction === null || otherFraction > fraction))
    return false;
  return (
    other.remaining !== window.remaining ||
    otherFraction !== fraction ||
    otherIndex < index
  );
}

export class StatusPollPacing {
  private previous: string | undefined;
  private cadence = 0;
  private lower: BudgetWindow[] = [];
  private credential: string | undefined;
  private readonly maximumMs: number;
  private readonly baseMs: number;
  private readonly policy: StatusPolling;
  private readonly deps: Dependencies;

  constructor(baseMs: number, policy: StatusPolling, deps: Dependencies) {
    this.baseMs = baseMs;
    this.policy = policy;
    this.deps = deps;
    this.maximumMs = Math.max(baseMs, policy.maxIntervalSeconds * 1000);
  }

  /** Keep only readings another reading enforces at least as strictly. */
  private compactLower(now: number): void {
    const live = this.lower.filter(
      (window) => window.resetAt !== null && window.resetAt > now,
    );
    this.lower = live.filter(
      (window, index, all) =>
        !all.some((other, otherIndex) =>
          enforcesMoreStrictly(other, otherIndex, window, index),
        ),
    );
  }

  /** Forget the readings of another credential. */
  private adoptCredential(sample: BalanceSample): void {
    if (
      sample.credential === undefined ||
      sample.credential === this.credential
    )
      return;
    this.lower = [];
    this.credential = sample.credential;
  }

  /** A single known capacity completes the readings that omit their limit. */
  private completeLimits(): void {
    const capacities = new Set(
      this.lower
        .map(({ limit }) => limit)
        .filter((limit): limit is number => limit !== null && limit > 0),
    );
    if (capacities.size !== 1) return;
    const [limit] = capacities;
    this.lower = this.lower.map((window) =>
      window.limit === null && limit !== undefined
        ? { ...window, limit }
        : window,
    );
  }

  /** The earliest the next poll may start, given one reading. */
  private pollAfter(
    low: BudgetWindow,
    started: number,
    pollAt: number,
    maximumMs: number,
  ): number {
    const share = this.policy.waitingShare;
    if (share <= 0 || low.remaining === null || low.resetAt === null)
      return pollAt;
    // Some GraphQL answers give a balance and reset without reporting the limit.
    const fraction = remainingFraction(low);
    if (low.remaining <= 0 || (fraction !== null && fraction <= share / 5))
      return Math.max(pollAt, low.resetAt);
    if (fraction === null || fraction >= share) return pollAt;
    const stretched = Math.min(
      maximumMs,
      Math.ceil((this.baseMs * share) / fraction),
      Math.max(this.baseMs, low.resetAt - started),
    );
    return Math.max(pollAt, started + stretched);
  }

  /** An unchanged signal doubles the interval up to the ceiling. */
  private nextCadence(signal: string, maximumMs: number): number {
    return signal === this.previous
      ? Math.min(maximumMs, this.cadence * 2)
      : Math.min(this.baseMs, maximumMs);
  }

  async wait(
    signal: string,
    deadline: number,
    abort?: AbortSignal,
    maximumMs = this.maximumMs,
  ): Promise<boolean> {
    this.cadence = this.nextCadence(signal, maximumMs);
    this.previous = signal;
    const started = this.deps.now();
    let pollAt = started + this.cadence;
    let sample = this.deps.balance();
    for (;;) {
      const now = this.deps.now();
      this.adoptCredential(sample);
      this.lower = [...this.lower, ...sample.windows];
      this.compactLower(now);
      this.completeLimits();
      for (const low of this.lower)
        pollAt = this.pollAfter(low, started, pollAt, maximumMs);
      const wakeAt = Math.min(pollAt, deadline);
      if (wakeAt <= now || abort?.aborted) break;
      await this.deps.sleep(wakeAt - now, abort);
      if (abort?.aborted) break;
      sample = this.deps.balance();
    }
    const ended = this.deps.now();
    const willPoll = !abort?.aborted && ended < deadline;
    this.deps.record(
      this.credential,
      ended - started,
      this.skippedPolls(started, ended, willPoll),
    );
    return willPoll;
  }

  /** The polls the wait stood in for, less the one about to happen. */
  private skippedPolls(
    started: number,
    ended: number,
    willPoll: boolean,
  ): number {
    return Math.max(
      0,
      Math.floor((ended - started) / this.baseMs) - (willPoll ? 1 : 0),
    );
  }
}
