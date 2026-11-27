import { type Clock, systemClock } from "../../../../../shared/clock.ts";
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

const quotaLabel = { requests: "REST core", complexity: "GraphQL" } as const;
type PollQuota = keyof typeof quotaLabel;

interface BalanceSample {
  windows: Partial<Record<PollQuota, BudgetWindow[]>>;
  credential?: string;
}

function readBalance(
  now: number,
  balances: ReturnType<typeof githubBalances>,
): BalanceSample {
  if (balances === null) return { windows: {} };
  return {
    windows: {
      requests: [balances.core],
      complexity: [
        balances.graphql,
        ...graphqlPollFloors(balances.windows, now),
      ],
    },
    ...definedFields({ credential: balances.credential }),
  };
}

interface Dependencies extends Clock {
  balance(): BalanceSample;
  record(
    credential: string | undefined,
    ms: number,
    skipped: number,
    quota?: PollQuota,
    operation?: string,
  ): void;
}

// Leave enough time for the final loop iteration to start its forge read even
// when the timer fires late and this wait records its outbound-call telemetry.
const FINAL_EVALUATION_MARGIN_MS = 1_000;

export function pollDependencies(
  clock: Clock,
  read = () => (forgeBudgetOn() ? githubBalances() : null),
): Dependencies {
  return {
    ...clock,
    balance: () => readBalance(clock.now(), read()),
    record(credential, durationMs, skipped, quota, operation = "drive-status") {
      const suffix = quota === undefined ? "" : ` (${quotaLabel[quota]})`;
      const entry = {
        system: "github",
        credential: credential ?? "(unavailable)",
        owner: credential ?? null,
        window: quota ?? "none",
        unit: "polls",
        requests: 0,
      };
      recordCall({
        ...entry,
        operation: `${operation} poll wait${suffix}`,
        cost: 1,
        durationMs,
      });
      if (skipped > 0)
        recordCall({
          ...entry,
          operation: `${operation} poll skipped${suffix}`,
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

const pollQuotas = ["requests", "complexity"] as const;

/** Keep the strictest live readings and infer missing limits within one quota. */
function retainWindows(windows: BudgetWindow[], now: number): BudgetWindow[] {
  const live = windows.filter(
    (window) => window.resetAt !== null && window.resetAt > now,
  );
  const lowest = live.filter(
    (window, index) =>
      !live.some((other, otherIndex) =>
        enforcesMoreStrictly(other, otherIndex, window, index),
      ),
  );
  const capacities = new Set(
    lowest
      .map(({ limit }) => limit)
      .filter((limit): limit is number => limit !== null && limit > 0),
  );
  if (capacities.size !== 1) return lowest;
  const [limit] = capacities;
  return lowest.map((window) =>
    window.limit === null && limit !== undefined
      ? { ...window, limit }
      : window,
  );
}

/** A drive's waiting readers use the most restrictive live quota. */
class QuotaPollPacing {
  private lower: Record<PollQuota, BudgetWindow[]> = {
    requests: [],
    complexity: [],
  };
  private credential: string | undefined;
  private readonly waitingShare: number;
  private readonly deps: Dependencies;

  constructor(waitingShare: number, deps: Dependencies) {
    this.waitingShare = waitingShare;
    this.deps = deps;
  }

  /** Forget the readings of another credential. */
  private adoptCredential(sample: BalanceSample): void {
    if (
      sample.credential === undefined ||
      sample.credential === this.credential
    )
      return;
    this.lower = { requests: [], complexity: [] };
    this.credential = sample.credential;
  }

  /** The earliest the next poll may start, given one reading. */
  private pollAfter(
    low: BudgetWindow,
    started: number,
    pollAt: number,
    maximumMs: number,
    baseMs: number,
  ): number {
    const share = this.waitingShare;
    if (share <= 0 || low.remaining === null || low.resetAt === null)
      return pollAt;
    // Some GraphQL answers give a balance and reset without reporting the limit.
    const fraction = remainingFraction(low);
    if (low.remaining <= 0 || (fraction !== null && fraction <= share / 5))
      return Math.max(pollAt, low.resetAt);
    if (fraction === null || fraction >= share) return pollAt;
    const stretched = Math.min(
      maximumMs,
      Math.ceil((baseMs * share) / fraction),
      Math.max(baseMs, low.resetAt - started),
    );
    return Math.max(pollAt, started + stretched);
  }

  /** Fold one balance reading into the lowest windows held. */
  private absorb(): void {
    const now = this.deps.now();
    const sample = this.deps.balance();
    this.adoptCredential(sample);
    for (const quota of pollQuotas)
      this.lower[quota] = retainWindows(
        [...this.lower[quota], ...(sample.windows[quota] ?? [])],
        now,
      );
  }

  /** The poll time after every held window has had its say. */
  next(
    started: number,
    pollAt: number,
    maximumMs: number,
    baseMs: number,
  ): { at: number; quota: PollQuota | undefined } {
    this.absorb();
    let at = pollAt;
    let quota: PollQuota | undefined;
    for (const candidate of pollQuotas) {
      for (const low of this.lower[candidate]) {
        const next = this.pollAfter(low, started, at, maximumMs, baseMs);
        if (next > at) quota = candidate;
        at = next;
      }
    }
    return { at, quota };
  }

  record(
    ms: number,
    skipped: number,
    quota?: PollQuota,
    operation?: string,
  ): void {
    this.deps.record(this.credential, ms, skipped, quota, operation);
  }
}

/** Defer an optional repeated read without suspending the driver's local controls. */
export function optionalPollPacing(
  policy: StatusPolling,
  operation: string,
  deps = pollDependencies(systemClock),
): (lastRead: number, baseMs: number, deadline?: number) => boolean {
  const quota = new QuotaPollPacing(policy.waitingShare, deps);
  let recordedUntil = 0;
  return (lastRead, baseMs, deadline = Infinity) => {
    const now = deps.now();
    const due = lastRead + baseMs;
    const next = quota.next(
      lastRead,
      due,
      Math.max(baseMs, policy.maxIntervalSeconds * 1000),
      baseMs,
    );
    const until = Math.min(next.at, deadline);
    if (next.quota === undefined || until <= now) return false;
    if (now >= recordedUntil) {
      const interval = Math.min(until - now, baseMs);
      quota.record(interval, 1, next.quota, operation);
      recordedUntil = now + interval;
    }
    return true;
  };
}

export class StatusPollPacing {
  private previous: string | undefined;
  private cadence = 0;
  private finalEvaluationDeadline: number | undefined;
  private readonly maximumMs: number;
  private readonly baseMs: number;
  private readonly quota: QuotaPollPacing;
  private readonly deps: Dependencies;

  constructor(baseMs: number, policy: StatusPolling, deps: Dependencies) {
    this.baseMs = baseMs;
    this.quota = new QuotaPollPacing(policy.waitingShare, deps);
    this.deps = deps;
    this.maximumMs = Math.max(baseMs, policy.maxIntervalSeconds * 1000);
  }

  /** An unchanged signal doubles the interval up to the ceiling. */
  private nextCadence(signal: string, maximumMs: number): number {
    return signal === this.previous
      ? Math.min(maximumMs, this.cadence * 2)
      : Math.min(this.baseMs, maximumMs);
  }

  /** Whether the previous wait reserved this deadline's final evaluation and the clock is inside its margin. */
  private finalWaitDue(started: number, deadline: number): boolean {
    return (
      this.finalEvaluationDeadline === deadline &&
      started >= deadline - FINAL_EVALUATION_MARGIN_MS
    );
  }

  /** When to wake, and whether that wake reserves the final evaluation. */
  private wakeTime(
    pollAt: number,
    cadencePollAt: number,
    deadline: number,
    now: number,
  ): { wakeAt: number; reserves: boolean } {
    // Reserve a practical margin before the deadline for a final evaluation.
    // Otherwise timer lateness and the wait's own telemetry can leave the
    // consuming loop with no time to observe evidence from its last interval.
    // An ordinary cadence wake inside the final margin is itself the final
    // evaluation. Reserving another wake at the same time would return a
    // zero-delay poll on the next call. A budget-limited wake at that same
    // boundary is also an evaluation, so retain that reservation even when
    // the budget, rather than cadence, chose the wake time.
    const margin = deadline - FINAL_EVALUATION_MARGIN_MS;
    const reserves =
      pollAt >= margin && (pollAt === cadencePollAt || pollAt === margin);
    const wakeAt = Math.min(
      pollAt,
      reserves ? Math.max(now, margin) : deadline,
    );
    return { wakeAt, reserves };
  }

  async wait(
    signal: string,
    deadline: number,
    abort?: AbortSignal,
    maximumMs = this.maximumMs,
  ): Promise<boolean> {
    // A reviewer-specific ceiling limits backoff, not the caller's requested
    // polling interval. Keep the base interval as the floor so a low ceiling
    // cannot turn `--interval` into a faster forge-read cadence.
    const effectiveMaximumMs = Math.max(this.baseMs, maximumMs);
    const started = this.deps.now();
    if (this.finalWaitDue(started, deadline)) {
      this.finalEvaluationDeadline = undefined;
      if (started < deadline) await this.deps.sleep(deadline - started, abort);
      return false;
    }
    this.cadence = this.nextCadence(signal, effectiveMaximumMs);
    this.previous = signal;
    let pollAt = started + this.cadence;
    let limitingQuota: PollQuota | undefined;
    for (;;) {
      const now = this.deps.now();
      const cadencePollAt = pollAt;
      const budget = this.quota.next(
        started,
        pollAt,
        effectiveMaximumMs,
        this.baseMs,
      );
      pollAt = budget.at;
      limitingQuota = budget.quota ?? limitingQuota;
      const { wakeAt, reserves } = this.wakeTime(
        pollAt,
        cadencePollAt,
        deadline,
        now,
      );
      if (reserves) this.finalEvaluationDeadline = deadline;
      if (wakeAt <= now || abort?.aborted) break;
      await this.deps.sleep(wakeAt - now, abort);
      if (abort?.aborted) break;
    }
    return this.finish(started, deadline, abort, limitingQuota);
  }

  /** Record the wait and say whether the caller polls now. */
  private finish(
    started: number,
    deadline: number,
    abort: AbortSignal | undefined,
    quota: PollQuota | undefined,
  ): boolean {
    const ended = this.deps.now();
    const willPoll = !abort?.aborted && ended < deadline;
    // A wake that lands inside the final margin without a reservation (the
    // cadence wake was just before it, or a timer ran late) is itself the final
    // evaluation; reserve it so the next call does not poll again at once.
    if (willPoll && ended >= deadline - FINAL_EVALUATION_MARGIN_MS)
      this.finalEvaluationDeadline = deadline;
    this.quota.record(
      ended - started,
      this.skippedPolls(started, ended, willPoll),
      quota,
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
