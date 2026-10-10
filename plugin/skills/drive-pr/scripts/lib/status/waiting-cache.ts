/** Reuse only a bounded waiting observation; terminal claims always gather anew. */
import {
  checkSignalsUnchanged,
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
} from "../gh-conditional.ts";
import type { EvaluateContext, StatusReport } from "./evaluate.ts";

export function waitingChecksMaxAgeMs(
  raw = process.env.AWAIT_ROUND_CHECKS_MAX_AGE ?? "300",
): number {
  if (!/^\d+$/.test(raw) || Number(raw) > 86400) {
    throw new Error(
      `AWAIT_ROUND_CHECKS_MAX_AGE must be a whole number of seconds, at most 86400 (got '${raw}')`,
    );
  }
  return Number(raw) * 1000;
}

interface Signals {
  head: string;
  pullBody: string;
  unchanged: boolean;
}

type WaitingContext = Pick<
  EvaluateContext,
  "pr" | "owner" | "repo" | "localHead" | "helperTimeoutSec"
>;

/** The injectable reader lets tests drive changes without sharing real cache state. */
export interface WaitingCacheDependencies {
  enabled(): boolean;
  now(): number;
  signals(ctx: WaitingContext): Promise<Signals | null>;
}

async function readSignals(ctx: WaitingContext): Promise<Signals | null> {
  const pull = await ghConditionalGet(
    `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.pr}`,
    {
      timeoutSec: ctx.helperTimeoutSec,
      caller: "evaluate-waiting",
    },
  );
  if (!pull.ok) return null;
  let doc: {
    state?: unknown;
    merged?: unknown;
    head?: { sha?: unknown } | null;
  };
  try {
    const parsed: unknown = JSON.parse(pull.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    doc = parsed as typeof doc;
  } catch {
    return null;
  }
  const head = doc.head?.sha;
  if (
    doc.state !== "open" ||
    doc.merged === true ||
    typeof head !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(head)
  )
    return null;
  // Prime BEFORE the authoritative evaluation. A sticky edit can release a
  // stranded in-progress reviewer even when its check-run has not changed.
  const comments = await ghConditionalProbe(
    `repos/${ctx.owner}/${ctx.repo}/issues/${ctx.pr}/comments?per_page=100`,
    {
      timeoutSec: ctx.helperTimeoutSec,
      caller: "evaluate-waiting",
    },
  );
  const unchanged = await checkSignalsUnchanged(head);
  return {
    head,
    pullBody: pull.body,
    unchanged: unchanged && comments.ok && !comments.changed,
  };
}

/** Per invocation, never persisted: another process cannot advance this baseline. */
export class WaitingEvaluationCache {
  private waiting: {
    report: StatusReport;
    at: number;
    pullBody: string;
    localHead: string;
    identity: string;
  } | null = null;

  private readonly maxAgeMs: number;
  private readonly deps: WaitingCacheDependencies;

  constructor(
    maxAgeMs: number,
    deps: WaitingCacheDependencies = {
      enabled: () => ghCacheDir() !== null,
      now: Date.now,
      signals: readSignals,
    },
  ) {
    this.maxAgeMs = maxAgeMs;
    this.deps = deps;
  }

  async evaluate(
    ctx: WaitingContext,
    report: StatusReport,
    authoritative: () => Promise<number>,
  ): Promise<number> {
    if (this.maxAgeMs === 0 || !this.deps.enabled()) {
      this.waiting = null;
      return authoritative();
    }
    const identity = JSON.stringify([ctx.owner, ctx.repo, ctx.pr]);
    // Age counts from when the evidence was gathered, not from when it is stored.
    const observedAt = this.deps.now();
    const signals = await this.deps.signals(ctx);
    const previous = this.waiting;
    if (
      previous &&
      signals?.unchanged &&
      previous.identity === identity &&
      previous.report.apiHead === signals.head &&
      previous.pullBody === signals.pullBody &&
      previous.localHead === ctx.localHead &&
      this.deps.now() >= previous.at &&
      this.deps.now() - previous.at < this.maxAgeMs
    ) {
      Object.assign(report, structuredClone(previous.report));
      return 4;
    }
    this.waiting = null;
    const code = await authoritative();
    // Completed reviewers can await a sticky/backlog publication. Their
    // eventual result depends on work enumeration, so gather those afresh.
    if (
      code === 4 &&
      report.state === "AWAITING_REVIEWER" &&
      report.reviewerStatus !== "completed" &&
      signals !== null &&
      signals.head === report.apiHead &&
      this.deps.now() - observedAt < this.maxAgeMs
    ) {
      this.waiting = {
        report: structuredClone(report),
        at: observedAt,
        pullBody: signals.pullBody,
        localHead: ctx.localHead,
        identity,
      };
    }
    return code;
  }
}
