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
    this.lower = live.filter((window, index, all) => {
      const fraction =
        window.limit !== null && window.limit > 0
          ? window.remaining !== null
            ? window.remaining / window.limit
            : null
          : null;
      return !all.some((other, otherIndex) => {
        if (otherIndex === index || other.resetAt !== window.resetAt)
          return false;
        if (
          other.remaining === null ||
          window.remaining === null ||
          other.remaining > window.remaining
        )
          return false;
        const otherFraction =
          other.limit !== null && other.limit > 0
            ? other.remaining / other.limit
            : null;
        return (
          (fraction === null ||
            (otherFraction !== null && otherFraction <= fraction)) &&
          (other.remaining < window.remaining ||
            otherFraction !== fraction ||
            otherIndex < index)
        );
      });
    });
  }

  async wait(
    signal: string,
    deadline: number,
    abort?: AbortSignal,
  ): Promise<boolean> {
    this.cadence =
      signal === this.previous
        ? Math.min(this.maximumMs, this.cadence * 2)
        : this.baseMs;
    this.previous = signal;
    const started = this.deps.now();
    let pollAt = started + this.cadence;
    let sample = this.deps.balance();
    for (;;) {
      const now = this.deps.now();
      if (
        sample.credential !== undefined &&
        sample.credential !== this.credential
      ) {
        this.lower = [];
        this.credential = sample.credential;
      }
      const share = this.policy.waitingShare;
      this.lower = [...this.lower, ...sample.windows];
      this.compactLower(now);
      const capacities = new Set(
        this.lower
          .map(({ limit }) => limit)
          .filter((limit): limit is number => limit !== null && limit > 0),
      );
      if (capacities.size === 1) {
        const [limit] = capacities;
        this.lower = this.lower.map((window) =>
          window.limit === null && limit !== undefined
            ? { ...window, limit }
            : window,
        );
      }
      for (const low of this.lower) {
        if (share <= 0 || low.remaining === null || low.resetAt === null)
          continue;
        // Some GraphQL answers give a balance and reset without reporting the limit.
        const fraction =
          low.limit !== null && low.limit > 0
            ? low.remaining / low.limit
            : null;
        if (
          low.remaining <= 0 ||
          (fraction !== null && fraction <= share / 5)
        ) {
          pollAt = Math.max(pollAt, low.resetAt);
        } else if (fraction !== null && fraction < share) {
          const stretched = Math.min(
            this.maximumMs,
            Math.ceil((this.baseMs * share) / fraction),
            Math.max(this.baseMs, low.resetAt - started),
          );
          pollAt = Math.max(pollAt, started + stretched);
        }
      }
      const wakeAt = Math.min(pollAt, deadline);
      if (wakeAt <= now || abort?.aborted) break;
      await this.deps.sleep(wakeAt - now, abort);
      if (abort?.aborted) break;
      sample = this.deps.balance();
    }
    const ended = this.deps.now();
    const willPoll = !abort?.aborted && ended < deadline;
    const skipped = Math.max(
      0,
      Math.floor((ended - started) / this.baseMs) - (willPoll ? 1 : 0),
    );
    this.deps.record(this.credential, ended - started, skipped);
    return willPoll;
  }
}
