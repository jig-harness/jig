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

export interface FinalCiSignals {
  head: string;
  pull: string;
  unchanged: boolean;
  /** When the read STARTED: the age bound counts from the evidence, not from remember(). */
  observedAt: number;
}

export interface FinalCiWaitDeps {
  now(): number;
  signals(pr: string): Promise<FinalCiSignals | null>;
}

async function signals(pr: string): Promise<FinalCiSignals | null> {
  const observedAt = Date.now();
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
  private waiting: {
    signals: FinalCiSignals;
    at: number;
    unwitnessed: boolean;
  } | null = null;

  private readonly pr: string;
  private readonly maxAgeMs: number;
  private readonly deps: FinalCiWaitDeps;

  constructor(
    pr: string,
    maxAgeMs = ghCacheDir() === null ? 0 : waitingChecksMaxAgeMs(),
    deps: FinalCiWaitDeps = { now: Date.now, signals },
  ) {
    this.pr = pr;
    this.maxAgeMs = maxAgeMs;
    this.deps = deps;
  }

  clear(): void {
    this.waiting = null;
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
  ): Promise<"witness" | "pending" | null> {
    const previous = this.waiting;
    if (previous === null) return null;
    const age = this.deps.now() - previous.at;
    // At the bound, gather live evidence before the driver's give-up branch.
    if (
      age < 0 ||
      age >= this.maxAgeMs ||
      (previous.unwitnessed && witnessLimit > 0 && witnessWaits >= witnessLimit)
    ) {
      this.clear();
      return null;
    }
    const current = await this.deps.signals(this.pr);
    const ageAfterRead = this.deps.now() - previous.at;
    if (
      current === null ||
      ageAfterRead < 0 ||
      ageAfterRead >= this.maxAgeMs ||
      !current.unchanged ||
      current.head !== previous.signals.head ||
      current.pull !== previous.signals.pull
    ) {
      this.clear();
      return null;
    }
    return previous.unwitnessed ? "witness" : "pending";
  }
}
