/**
 * Reuse only the decision to keep waiting for final CI. This gate
 * never supplies a status report or a terminal verdict. A changed/unreadable
 * signal, age bound, or witness-wait bound sends the driver through its live
 * ci-hold + drive-status path again before it can stop or dispatch work.
 */
import {
  checkSignalsUnchanged,
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
} from "./gh-conditional.ts";
import { waitingChecksMaxAgeMs } from "./status/waiting-cache.ts";
import { type Clock, systemClock } from "../../../../shared/clock.ts";
import { currentMs } from "../../../../shared/time.ts";

export interface FinalCiSignals {
  head: string;
  pull: string;
  unchanged: boolean;
  /** When the read STARTED: the age bound counts from the evidence, not from remember(). */
  observedAt: number;
}

export interface FinalCiWaitDeps extends Pick<Clock, "now"> {
  signals(pr: string): Promise<FinalCiSignals | null>;
}

async function signals(pr: string): Promise<FinalCiSignals | null> {
  const observedAt = currentMs();
  const pull = await ghConditionalGet(`repos/{owner}/{repo}/pulls/${pr}`);
  if (!pull.ok) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(pull.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const head = value.head as { sha?: unknown } | null | undefined;
  if (
    value.state !== "open" ||
    value.merged === true ||
    typeof head?.sha !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(head.sha)
  )
    return null;
  // Review/label events can change without changing the pull resource. These
  // are detectors only; the authoritative readers still paginate every page.
  const [checks, comments, reviews, timeline] = await Promise.all([
    checkSignalsUnchanged(head.sha),
    ghConditionalProbe(
      `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
    ),
    ghConditionalProbe(
      `repos/{owner}/{repo}/pulls/${pr}/comments?per_page=100`,
    ),
    ghConditionalProbe(
      `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
    ),
  ]);
  return {
    head: head.sha,
    observedAt,
    // Compare to THIS driver's own body, not the shared disk cache's changed
    // flag: another process may have refreshed the ETag since our last read.
    pull: pull.body,
    unchanged:
      checks &&
      comments.ok &&
      !comments.changed &&
      reviews.ok &&
      !reviews.changed &&
      timeline.ok &&
      !timeline.changed,
  };
}

export class FinalCiWait {
  private nextProbeAt = 0;
  private probeIntervalMs = 10_000;
  private witness: { head: string; since: number } | null = null;
  private waiting: {
    signals: FinalCiSignals;
    at: number;
    unwitnessed: boolean;
  } | null = null;

  private readonly pr: string;
  private readonly maxAgeMs: number;
  private readonly deps: FinalCiWaitDeps;
  private readonly witnessUnitMs: number;

  constructor(
    pr: string,
    maxAgeMs = ghCacheDir() === null ? 0 : waitingChecksMaxAgeMs(),
    deps: FinalCiWaitDeps = { now: systemClock.now, signals },
    witnessUnitMs = 10_000,
  ) {
    this.pr = pr;
    this.maxAgeMs = maxAgeMs;
    this.deps = deps;
    this.witnessUnitMs = witnessUnitMs;
  }

  clear(): void {
    this.waiting = null;
    this.nextProbeAt = 0;
    this.probeIntervalMs = 10_000;
  }

  resetWitness(): void {
    this.witness = null;
  }

  /** The legacy setting is a duration in ten-second units, never a poll count. */
  witnessSpent(head: string, limit: number): boolean {
    if (this.witness?.head !== head)
      this.witness = { head, since: this.deps.now() };
    return this.deps.now() >= this.witnessDeadline(limit);
  }

  witnessDeadline(limit: number): number {
    return limit > 0 && this.witness !== null
      ? this.witness.since + limit * this.witnessUnitMs
      : Infinity;
  }

  /** Prime before live witnesses, so an intervening change cannot be absorbed. */
  async prime(): Promise<FinalCiSignals | null> {
    this.clear();
    return this.maxAgeMs > 0 ? this.deps.signals(this.pr) : null;
  }

  /** Only called from confirmed keep-waiting branches, never a success branch. */
  remember(
    head: string,
    before: FinalCiSignals | null,
    unwitnessed: boolean,
  ): void {
    // Age from when the evidence was read, and refuse to arm a wait that the
    // intervening live evaluation already outlasted.
    this.waiting =
      before !== null &&
      before.head === head &&
      this.deps.now() - before.observedAt < this.maxAgeMs
        ? { signals: before, at: before.observedAt, unwitnessed }
        : null;
  }

  async skip(
    witnessWaits: number,
    witnessLimit: number,
    witnessDeadline = this.witnessDeadline(witnessLimit),
  ): Promise<"witness" | "pending" | null> {
    const previous = this.waiting;
    if (previous === null) return null;
    const age = this.deps.now() - previous.at;
    // At the bound, gather live evidence before the driver's give-up branch.
    if (
      age < 0 ||
      age >= this.maxAgeMs ||
      (previous.unwitnessed && this.deps.now() >= witnessDeadline) ||
      (previous.unwitnessed && witnessLimit > 0 && witnessWaits >= witnessLimit)
    ) {
      this.clear();
      return null;
    }
    // This is only permission to keep waiting, never evidence for a verdict.
    // Local controls still run every ten seconds in the driver boundary.
    if (this.deps.now() < this.nextProbeAt)
      return previous.unwitnessed ? "witness" : "pending";
    const current = await this.deps.signals(this.pr);
    const ageAfterRead = this.deps.now() - previous.at;
    if (
      current === null ||
      (previous.unwitnessed && this.deps.now() >= witnessDeadline) ||
      ageAfterRead < 0 ||
      ageAfterRead >= this.maxAgeMs ||
      !current.unchanged ||
      current.head !== previous.signals.head ||
      current.pull !== previous.signals.pull
    ) {
      this.clear();
      return null;
    }
    this.probeIntervalMs = Math.min(60_000, this.probeIntervalMs * 2);
    this.nextProbeAt = current.observedAt + this.probeIntervalMs;
    return previous.unwitnessed ? "witness" : "pending";
  }
}
