#!/usr/bin/env bun
/**
 * fleet-health.ts — the ceremony-versus-progress sensor.
 *
 * One command, every signal, for a window:
 *
 *   ceremony ratio          per epic: ceremony units ÷ progress units
 *   follow-up depth         per PR: how many review-follow-up links deep it sits
 *   review carousel         per PR: many bot-reviewed heads, most churn after review began
 *   delivery-system share   organization-wide: merged change in delivery-system areas
 *
 * Definitions and thresholds are the consumer's fleet-health configuration
 * (`fleet_health.config`, see `lib/fleet-health-config.ts`). This file holds
 * neither. It EXTENDS the scoreboard (`fractal-metrics.ts`) rather than
 * beside it: it reuses that scoreboard's PR sampler, round definition and
 * window arithmetic.
 *
 * A signal is a SUSPICION. This command never confirms a pathology: only a
 * diagnosis comment on the epic does. Nothing here pages an agent; the
 * durable address for an epic-scoped suspicion is a comment on that epic, and
 * `--post` is the only path that writes one.
 *
 * Usage:
 *   fleet-health.ts [--days N] [--until YYYY-MM-DD] [--limit N]
 *                   [--concurrency N] [--json] [--out FILE] [--post]
 *
 *   --days N     window length, default from the config (14). Half-open
 *                `[until - N days, until)`, UTC.
 *   --until D    exclusive end of the window, default tomorrow (so today is in).
 *   --limit N    most PRs read per listing (default 600); a window past it is
 *                reported as capped, never silently truncated.
 *   --json       the machine-readable report (what the dashboard collector also
 *                publishes).
 *   --out FILE   write the report there instead of stdout.
 *   --post       comment on each epic that has a `new` suspicion. Without it the
 *                command mutates nothing anywhere.
 *
 * Exit codes:
 *   0  the report was produced in full
 *   1  the run could not start (config, listing, or window unreadable)
 *   2  usage error
 *   3  produced but PARTIAL — something that should have been read was not. The
 *      report is still printed, with the gap named.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calendarDate } from "./defect-escape.ts";
import { fail, positiveIntArg, runMain } from "./lib/cli.ts";
import {
  buildReport,
  inWindow,
  type CommentFact,
  type DepthResult,
  DISPOSITIONS,
  deriveLifecycle,
  type EpicActivityFact,
  censusCaveats,
  epicsOfPr,
  type FleetHealthReport,
  followupDepth,
  type IssueFact,
  lifecycleTargets,
  type PrFact,
  presentable,
  renderReport,
  suspicionComment,
  unattributedCeremony,
  unparsedDiagnoses,
  type WindowSpec,
} from "./lib/fleet-health.ts";
import {
  type FleetHealthConfig,
  loadConfig,
} from "./lib/fleet-health-config.ts";
import {
  type Candidates,
  type Classifier,
  connectTracker,
  deliveryFactOf,
  type EpicComments,
  fetchAcceptedEpics,
  fetchEpicActivity,
  fetchEpicComments,
  fetchIssuesByIds,
  fetchPrBody,
  fetchPrFiles,
  fetchReviewedHeads,
  fetchWindowIssues,
  type GraphqlBudget,
  graphqlBudget,
  listCandidatePrs,
  makeClassifier,
  type PrFileStat,
  type PrListing,
  parseIssueRefs,
  type WindowIssues,
} from "./lib/fleet-health-sources.ts";
import { computeLoopMetrics, initiatingBotReviews } from "./lib/metrics.ts";
import { type PrSample, resolveRepo, samplePr } from "./lib/sample.ts";
import type { Tracker } from "../../do-item/scripts/lib/tracker/port.ts";

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 600;
const DEFAULT_CONCURRENCY = 4;
/**
 * Below this many GraphQL points a sampling run is refused: the sampler spends
 * tens of points per PR against a budget every agent on this token shares.
 */
export const MIN_GRAPHQL_BUDGET = 2500;
/**
 * When the last this-many sample attempts ALL failed, the rest are not attempted:
 * an outage (a rate limit, a dead token) is not going to clear mid-run, and every
 * further attempt spends shared budget to learn nothing. Equivalent to "N
 * failures in a row, reset by any success" — the window form just reads off the
 * recorded outcomes in completion order, which is what concurrent workers produce.
 */
const SAMPLE_FAILURE_BREAKER = 5;

export interface RunOptions {
  /** Exclusive end of the window, as `YYYY-MM-DD` (UTC midnight). */
  until: string;
  days: number;
  limit: number;
  concurrency: number;
}

export interface RunDeps {
  cfg: FleetHealthConfig;
  nowMs(): number;
  /** `null` = unreadable; the run proceeds and reports its own failures. */
  budget(): Promise<GraphqlBudget | null>;
  listCandidates(win: WindowSpec, limit: number): Promise<Candidates>;
  /** Distinct reviewed commits, `null` when unreadable (the PR is then sampled to be safe). */
  reviewedHeads(pr: number): Promise<number | null>;
  samplePr(pr: number, asOf: string | undefined): Promise<PrSample>;
  prFiles(pr: number): Promise<PrFileStat[]>;
  prBody(pr: number): Promise<string | null>;
  /** `null` + a reason when the catalog could not be loaded. */
  classifier: Classifier | null;
  classifierError: string | null;
  /** `null` + a reason when the issue tracker could not be reached. */
  tracker: Tracker | null;
  trackerError: string | null;
  fetchIssues(ids: ReadonlyArray<string>): Promise<Map<string, IssueFact>>;
  fetchWindowIssues(win: WindowSpec): Promise<WindowIssues>;
  fetchEpicActivity(signal?: AbortSignal): Promise<EpicActivityFact[]>;
  fetchAcceptedEpics(win: WindowSpec): Promise<Set<string>>;
  fetchEpicComments(epic: string): Promise<EpicComments>;
  note(msg: string): void;
  /**
   * The collector's deadline. Checked before every new dispatch — a sample, a
   * file listing, a tracker stage, an epic-comment read, a follow-up walk. The
   * ports themselves take no signal, so a call already in flight runs to its own
   * per-call timeout; nothing further is started after the abort.
   */
  signal?: AbortSignal;
}

/** The run refused to start: its cost would not fit the shared GitHub budget. */
export class BudgetError extends Error {}

export interface RunResult {
  report: FleetHealthReport;
  /** Per-epic comments and UUIDs the lifecycle was read from — what `--post` needs. */
  epicComments: Map<string, EpicComments>;
  /** Epics whose comments were needed and could not be read: never posted on. */
  unknownEpics: Set<string>;
}

const DEADLINE_MESSAGE = "the collector deadline passed";

async function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return results;
}

/** First-review time of each bot-reviewed head, in round order. */
function roundTimes(sample: PrSample): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of initiatingBotReviews(sample.reviews)) {
    if (seen.has(r.oid)) continue;
    seen.add(r.oid);
    out.push(r.submittedAt);
  }
  return out;
}

/**
 * Everything `main()` does after argv parsing — its own injectable function so
 * a test (and the dashboard collector) exercises the REAL composition rather
 * than a hand-rebuilt copy.
 */
export async function runFleetHealth(
  opts: RunOptions,
  deps: RunDeps,
): Promise<RunResult> {
  const { cfg } = deps;
  const nowMs = deps.nowMs();
  const untilMs = Date.parse(`${opts.until}T00:00:00Z`);
  const win: WindowSpec = { sinceMs: untilMs - opts.days * DAY_MS, untilMs };
  const gaps: string[] = [];
  const caveats: string[] = [];

  // ── PRs ──────────────────────────────────────────────────────────────────
  // A run whose deadline has already passed starts no operation at all: no
  // budget read, no listing — the report carries only the deadline gap.
  // A function, not a captured value: control-flow narrowing would otherwise
  // pin an earlier read of the signal across every later await.
  const deadlineFired = (): boolean => deps.signal?.aborted === true;
  let aborted = deadlineFired();
  if (aborted) gaps.push("the collector deadline passed before any read began");
  const budget = aborted ? null : await deps.budget();
  if (budget !== null && budget.remaining < MIN_GRAPHQL_BUDGET) {
    throw new BudgetError(
      `GitHub's GraphQL budget is ${budget.remaining} (< ${MIN_GRAPHQL_BUDGET}) until ${budget.resetAt}; a run would starve every other agent on this token`,
    );
  }
  // The deadline can also fire while the budget read is pending; the captured
  // flag above cannot see that, so re-read the live signal before dispatching.
  if (!aborted && deadlineFired()) {
    aborted = true;
    gaps.push("the collector deadline passed during the budget read");
  }
  const candidates: Candidates = aborted
    ? { prs: [], capped: false }
    : await deps.listCandidates(win, opts.limit);
  if (candidates.capped) {
    gaps.push(
      `a PR listing holds more than --limit ${opts.limit}; the oldest were not read, so every figure is a lower bound`,
    );
  }
  const asOf = untilMs <= nowMs ? new Date(untilMs).toISOString() : undefined;
  if (budget === null && !aborted) {
    caveats.push(
      "GitHub's GraphQL budget could not be read before the run, so it was not gated on.",
    );
  }
  const failed: number[] = [];
  const pastEndPrs: number[] = [];
  const failureReasons = new Set<string>();
  const recentAttempts: boolean[] = [];
  let breakerTripped = false;
  const listings = new Map<number, PrListing>(
    candidates.prs.map((p) => [p.number, p]),
  );
  const facts = (
    await mapLimit(
      candidates.prs,
      opts.concurrency,
      async (l, i): Promise<PrFact | null> => {
        // A PR with no more reviewed heads than `free_rounds` has no ceremony
        // rounds and cannot be a carousel, so the (expensive) sample is skipped;
        // the listing alone decides whether it merged or closed in the window.
        // Checked before ANY per-PR read, the review-list request included: once
        // the collector deadline has fired no further operation may start.
        if (deps.signal?.aborted === true) {
          aborted = true;
          failed.push(l.number);
          return null;
        }
        const heads = await deps.reviewedHeads(l.number);
        // The deadline may have fired while `reviewedHeads` was pending; check
        // before either head-count branch retains this PR.
        if (deadlineFired()) {
          aborted = true;
          failed.push(l.number);
          return null;
        }
        if (heads !== null && heads <= cfg.ceremony.freeRounds) {
          // No rounds to charge and no carousel possible, so no sample. The listing
          // still decides whether the PR matters: merged in the window (progress,
          // delivery share), closed in it, or open — the last two can still close a
          // follow-up issue, and follow-up depth reads only the PR body.
          if (
            !inWindow(l.mergedAt, win) &&
            !inWindow(l.closedAt, win) &&
            !inWindow(l.createdAt, win) &&
            (l.state !== "OPEN" || !inWindow(l.updatedAt, win))
          )
            return null;
          return {
            number: l.number,
            title: l.title,
            state: l.state,
            mergedAt: l.mergedAt,
            issueRefs: parseIssueRefs(l.body, cfg.keys),
            rounds: [],
            postReviewShare: null,
            postReviewAdditions: 0,
            openingAdditions: 0,
            threads: { total: 0, answered: 0, accepted: 0 },
            productPr: null,
          };
        }
        if (breakerTripped) {
          failed.push(l.number);
          return null;
        }
        deps.note(`prs: [${i + 1}/${candidates.prs.length}] #${l.number}`);
        let sample: PrSample;
        try {
          sample = await deps.samplePr(l.number, asOf);
          recentAttempts.push(true);
        } catch (err) {
          failed.push(l.number);
          const why = err instanceof Error ? err.message : String(err);
          failureReasons.add(why);
          recentAttempts.push(false);
          const window = recentAttempts.slice(-SAMPLE_FAILURE_BREAKER);
          if (
            window.length === SAMPLE_FAILURE_BREAKER &&
            window.every((ok) => !ok)
          ) {
            breakerTripped = true;
          }
          deps.note(`prs: #${l.number} unreadable (${why})`);
          return null;
        }
        const allRounds = roundTimes(sample);
        const activeInWindow =
          inWindow(l.mergedAt, win) ||
          inWindow(l.closedAt, win) ||
          allRounds.some((at) => inWindow(at, win)) ||
          inWindow(l.createdAt, win) ||
          (l.state === "OPEN" && inWindow(l.updatedAt, win));
        if (!activeInWindow) return null;
        // Rounds after the window's end are not this window's. The churn split
        // comes from the whole commit and review history (`samplePr` bounds only
        // thread settlement by `asOf`), so once the PR carries work past the end
        // the share describes a later period and is reported as not measured
        // rather than attributed to this one. Work is "past the end" by a bot
        // review OR a commit after the window: later commits with no later
        // review still change the share.
        const rounds = allRounds.filter((at) => Date.parse(at) < win.untilMs);
        const pastEnd =
          rounds.length < allRounds.length ||
          sample.commits.some(
            (c) => Date.parse(c.committedDate) >= win.untilMs,
          );
        if (pastEnd) pastEndPrs.push(l.number);
        const m = computeLoopMetrics(sample, null, new Set());
        return {
          number: l.number,
          title: l.title,
          state: l.state,
          mergedAt: l.mergedAt,
          issueRefs: parseIssueRefs(l.body, cfg.keys),
          rounds,
          postReviewShare: pastEnd ? null : m.postReviewShare,
          postReviewAdditions: m.postReview.additions,
          openingAdditions: m.opening.additions,
          threads: {
            total: sample.threads.length,
            answered: sample.threads.filter((t) => t.outcome !== null).length,
            accepted: sample.threads.filter((t) => t.outcome === "accepted")
              .length,
          },
          productPr: null,
        };
      },
    )
  ).filter((f): f is PrFact => f !== null);
  if (failed.length > 0) {
    const why = [
      ...(failureReasons.size > 0
        ? [`first failure: ${[...failureReasons][0]}`]
        : []),
      ...(breakerTripped
        ? [`sampling stopped after ${SAMPLE_FAILURE_BREAKER} failures in a row`]
        : []),
      ...(aborted ? ["the collector deadline passed"] : []),
    ].join("; ");
    gaps.push(
      `${failed.length} PR(s) could not be sampled and are absent from every figure${why === "" ? "" : ` (${why})`}: ${failed
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ")}`,
    );
  }

  // ── Change-area classification of what merged ────────────────────────────
  const mergedInWindow = facts.filter(
    (f) => f.state === "MERGED" && inWindow(f.mergedAt, win),
  );
  let delivery = null as ReturnType<typeof deliveryFactOf> | null;
  if (deps.classifier === null) {
    gaps.push(
      `merged PRs could not be classified by change area (${deps.classifierError ?? "catalog unavailable"}), so no PR counts as product progress and the delivery-system share is not measured`,
    );
  } else {
    const classifier = deps.classifier;
    const parts: Array<{
      deliveryLines: number;
      totalLines: number;
      unclaimedSkillLines: number;
    }> = [];
    const unclassified: number[] = [];
    await mapLimit(mergedInWindow, opts.concurrency, async (f) => {
      try {
        if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
        const files = await deps.prFiles(f.number);
        const c = classifier.classify(files);
        f.productPr = c.productPr;
        parts.push(c);
      } catch (err) {
        unclassified.push(f.number);
        deps.note(
          `files: #${f.number} unreadable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    });
    if (unclassified.length > 0) {
      gaps.push(
        `${unclassified.length} merged PR(s) could not have their files read and are absent from progress and the delivery-system share: ${unclassified
          .sort((a, b) => a - b)
          .map((n) => `#${n}`)
          .join(", ")}`,
      );
    }
    delivery = deliveryFactOf(parts);
  }

  // ── The issue tracker ────────────────────────────────────────────────────
  let issues = new Map<string, IssueFact>();
  let windowIssues: WindowIssues = {
    followups: [],
    sdlcIssues: [],
    completed: [],
  };
  let acceptedEpics = new Set<string>();
  let epicActivity: EpicActivityFact[] = [];
  // Issue IDs the PR trailers name, and whether the initial read of them
  // completed: the unresolved-ID gap is judged from the FINAL cache, after the
  // follow-up walk has had its chance to recover a missed ID.
  const named = [...new Set(facts.flatMap((f) => f.issueRefs))];
  let issuesFetched = false;
  if (deps.tracker === null) {
    gaps.push(
      `the issue tracker could not be reached (${deps.trackerError ?? "no port"}), so no PR is attributed to an epic and no epic-level signal is computed — only PR-level and organization-level signals remain`,
    );
  } else {
    try {
      const stop = (): void => {
        if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
      };
      stop();
      issues = await deps.fetchIssues(named);
      issuesFetched = true;
      stop();
      windowIssues = await deps.fetchWindowIssues(win);
      stop();
      acceptedEpics = await deps.fetchAcceptedEpics(win);
      stop();
      epicActivity = await deps.fetchEpicActivity(deps.signal);
    } catch (err) {
      gaps.push(
        `the tracker side could not be read in full (${err instanceof Error ? err.message : String(err)}); epic-level figures are missing or partial`,
      );
    }
  }

  // ── Follow-up depth ──────────────────────────────────────────────────────
  const issueCache = new Map(issues);
  // IDs a walk read and the tracker could not resolve (a deleted issue, a trailer
  // typo): recorded once so the same dead ID is not re-requested per PR per hop.
  const unresolvable = new Set<string>();
  // Bodies and issue reads are cached as promises for the WHOLE run: every top
  // level PR in a chain walks the same ancestors, and each read outside the
  // listing is a paid GitHub call.
  const bodyReads = new Map<number, Promise<string | null>>();
  const bodyOf = (pr: number): Promise<string | null> => {
    const known = listings.get(pr);
    if (known !== undefined) return Promise.resolve(known.body);
    let p = bodyReads.get(pr);
    if (p === undefined) {
      // A recursive walk dispatches reads outside the per-PR loop's own check.
      if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
      p = deps.prBody(pr);
      bodyReads.set(pr, p);
    }
    return p;
  };
  const issuesOfPr = async (
    pr: number,
  ): Promise<{ issues: IssueFact[]; complete: boolean } | null> => {
    const body = await bodyOf(pr);
    if (body === null) return null;
    const refs = parseIssueRefs(body, cfg.keys);
    const missing = refs.filter(
      (r) => !issueCache.has(r) && !unresolvable.has(r),
    );
    if (missing.length > 0 && deps.tracker !== null) {
      if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
      const got = await deps.fetchIssues(missing);
      for (const [k, v] of got) issueCache.set(k, v);
      for (const r of missing) if (!got.has(r)) unresolvable.add(r);
    }
    const resolved = refs.flatMap((r) => {
      const i = issueCache.get(r);
      return i === undefined ? [] : [i];
    });
    return { issues: resolved, complete: resolved.length === refs.length };
  };
  const depthByPr = new Map<number, DepthResult>();
  const depthMemo = new Map<string, Promise<DepthResult>>();
  const truncatedWalks: number[] = [];
  const originlessWalks: number[] = [];
  const failedWalks: string[] = [];
  const followupLabel = cfg.labels.followup;
  if (deps.tracker !== null && followupLabel !== null) {
    // One at a time: `followupDepth` shares in-flight walks through its memo, and
    // concurrent walks over a circular follow-up graph could wait on each other.
    await mapLimit(facts, 1, async (f) => {
      // Only a PR that closes a follow-up issue can have depth; skipping the
      // rest saves a walk per PR and changes no result.
      // An issue the initial batch could not resolve is not evidence either way:
      // `issuesOfPr` retries it through the cache, so it must not skip the walk.
      const closesFollowup = f.issueRefs.some((r) => {
        const known = issues.get(r);
        return known === undefined || known.labels.includes(followupLabel);
      });
      if (!closesFollowup) return;
      try {
        if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
        const d = await followupDepth(
          f.number,
          { issuesOfPr, followupLabel, keys: cfg.keys },
          cfg.signals.followupDepth.maxWalk,
          depthMemo,
        );
        depthByPr.set(f.number, d);
        if (d.truncated) truncatedWalks.push(f.number);
        if (d.originless) originlessWalks.push(f.number);
      } catch (err) {
        failedWalks.push(
          `#${f.number} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    });
    if (truncatedWalks.length > 0) {
      gaps.push(
        `${truncatedWalks.length} follow-up chain(s) could not be walked to their end (an unreadable PR, an unresolvable issue, a circular chain, or the ${cfg.signals.followupDepth.maxWalk}-hop limit), so their depth is a lower bound and a deeper chain may be missed: ${truncatedWalks
          .sort((a, b) => a - b)
          .map((n) => `#${n}`)
          .join(", ")}`,
      );
    }
    if (failedWalks.length > 0) {
      gaps.push(
        `follow-up depth could not be walked for: ${failedWalks.join(", ")}`,
      );
    }
  }

  // `fetchIssuesByIds` returns an absent ID without an error, and an issue a PR
  // names that is still missing after the walk drops that PR's epic attribution
  // — both its progress and its ceremony — so it is a gap, not a silent
  // omission. Read from `issueCache`, so an ID the walk recovered is not one.
  if (issuesFetched) {
    const unresolved = named.filter((r) => !issueCache.has(r));
    if (unresolved.length > 0) {
      gaps.push(
        `${unresolved.length} issue(s) named by a PR's Closes/References trailer could not be resolved in the tracker, so those PRs lose that epic attribution: ${unresolved.join(", ")}`,
      );
    }
  }

  // ── Report: first pass without comments, then read the comments it needs ──
  const base = {
    cfg,
    window: win,
    prs: facts,
    issues: issueCache,
    followups: windowIssues.followups,
    sdlcIssues: windowIssues.sdlcIssues,
    completed: windowIssues.completed,
    acceptedEpics,
    nowMs,
    depthByPr,
    epicActivity,
    delivery,
  };
  const unattributed = mergedInWindow.filter(
    (f) =>
      f.productPr === true &&
      epicsOfPr(f, issueCache, cfg.labels.epic).length === 0,
  ).length;
  caveats.push(
    `Ceremony is a LOWER BOUND: not measured — ${Object.entries(
      cfg.ceremony.unmeasured,
    )
      .map(([k, why]) => `${k} (${why})`)
      .join("; ")}.`,
    "Criteria closed is counted as issues in the epic tree reaching `completed` in the window: the tracker keeps no description history, so a checkbox flip cannot be dated.",
    "Post-review churn share is TEMPORAL, not causal (`lib/metrics.ts` § What the split does NOT establish); sibling-branch imports are not excluded here, which can only raise it.",
    "The stuck-epic signal is CURRENT state, not a reconstruction of the window: child `updatedAt` includes prose edits (an edit postpones a suspicion without proving delivery) and the clock starts no earlier than the epic `startedAt`.",
    ...censusCaveats(cfg),
    "A PR is attributed to the epic of EVERY issue its Closes/References trailers name, so a batched PR credits (and charges) more than one epic.",
    `${unattributed} merged product PR(s) name no epic-parented issue and count toward no epic's progress (they still count in the delivery-system share).`,
    `${unattributedCeremony({ cfg, window: win, prs: facts, issues: issueCache, followups: windowIssues.followups, sdlcIssues: windowIssues.sdlcIssues, completed: [], acceptedEpics: new Set() })} ceremony unit(s) name no epic (review rounds on a PR naming no epic-parented issue; follow-up or delivery-system issues with no epic ancestor) and are in no epic's ratio.`,
  );
  if (cfg.labels.followup === null) {
    caveats.push(
      "Follow-ups are NOT MEASURED: the consumer configures no follow-up label (labels.followup in the fleet-health config, or review.taxonomy.provenance_label), so follow-up depth and minted follow-ups are absent.",
    );
  }
  if (cfg.labels.deliverySystem === null) {
    caveats.push(
      "The delivery-system share and delivery-system issues are NOT MEASURED: the consumer configures no labels.delivery_system in the fleet-health config.",
    );
  }
  if (originlessWalks.length > 0) {
    caveats.push(
      `${originlessWalks.length} follow-up chain(s) end at a follow-up issue that records no originating PR (filed from an issue rather than a review thread), so their depth cannot be followed further and is a lower bound: ${originlessWalks
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ")}`,
    );
  }
  if (pastEndPrs.length > 0) {
    caveats.push(
      `${pastEndPrs.length} PR(s) carry bot-reviewed heads or commits after this window's end; any later rounds are cut at the end and their post-review churn share is not measured, because the commit history behind it is not window-bounded: ${pastEndPrs
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ")}`,
    );
  }
  if (untilMs < nowMs - DAY_MS) {
    caveats.push(
      "This window is in the past: PRs that existed during it are read from GitHub's update-ordered list, so one updated only long after the window may sit deeper than the page cap reaches and be missed. Thread outcomes are settled as of the window end.",
    );
  }

  const first = buildReport({
    ...base,
    epicComments: new Map(),
    gaps,
    caveats,
  });
  const needComments = new Set<string>();
  for (const s of first.signals) {
    if (s.severity !== null)
      for (const e of lifecycleTargets(s)) needComments.add(e);
  }
  const epicComments = new Map<string, EpicComments>();
  const unknownEpics = new Set<string>();
  if (deps.tracker !== null) {
    await mapLimit([...needComments], opts.concurrency, async (epic) => {
      try {
        if (deps.signal?.aborted === true) throw new Error(DEADLINE_MESSAGE);
        epicComments.set(epic, await deps.fetchEpicComments(epic));
      } catch (err) {
        unknownEpics.add(epic);
        gaps.push(
          `comments on ${epic} could not be read (${err instanceof Error ? err.message : String(err)}), so the lifecycle of its signals is unknown; they are shown as such and never commented on`,
        );
      }
    });
  }
  // An epic carrying a comment that says "diagnosis" but does not parse: its
  // owner believes a signal is answered, so `deriveLifecycle` reads the signals it
  // may concern as unknown (never presented on, like an unread epic). Named here — a caveat, not a gap: a
  // gap would keep every run partial until a person edited the comment.
  const unparsedOn: string[] = [];
  for (const [epic, c] of epicComments) {
    if (unparsedDiagnoses(c.comments).length > 0) unparsedOn.push(epic);
  }
  if (unparsedOn.length > 0) {
    caveats.push(
      `${unparsedOn.length} epic(s) carry a comment that begins "diagnosis" but does not parse (expected "**diagnosis** — <signal kind> — <${DISPOSITIONS.join("|")}> — <reason>"), so any signal it may concern is shown as unknown and never commented on until a later presentation or diagnosis supersedes it: ${unparsedOn.join(", ")}`,
    );
  }
  const commentFacts = new Map<string, CommentFact[]>(
    [...epicComments].map(([e, c]) => [e, c.comments]),
  );
  return {
    report: buildReport({
      ...base,
      epicComments: commentFacts,
      unknownEpics,
      gaps,
      caveats,
    }),
    epicComments,
    unknownEpics,
  };
}

export interface PostDeps {
  /** `issue` is the tracker id `fetchEpicComments` returned. */
  postComment(issue: string, body: string): Promise<void>;
  fetchEpicComments(epic: string): Promise<EpicComments>;
}

export interface PostOutcome {
  /** `kind→epic` pairs commented on. */
  posted: string[];
  /** Pairs that were due but not commented on, with why. */
  skipped: string[];
  failed: Array<{ target: string; error: string }>;
  /** Why nothing was attempted at all, or `null`. */
  refused: string | null;
}

/**
 * The ONLY writing path: comment once per (signal kind, epic) that has a `new`
 * suspicion.
 *
 * - It REFUSES on a partial report. A comment is a public accusation against an
 *   epic's owner, and every gap that makes the report partial — an unclassified
 *   catalog, an unread tracker page, a failed file listing — narrows the progress
 *   side or the lifecycle it is judged against. Measured in review: with the
 *   catalog unavailable no PR counts as progress, so every epic with five
 *   ceremony units reads "no progress" at maximum severity.
 * - It re-reads each epic's comments immediately before posting, so a comment
 *   that landed since the report was built (an earlier run, a person) is not
 *   talked over or duplicated. The read and the post are two remote operations
 *   and the tracker offers no conditional create, so two `--post` runs racing each
 *   other can both see `new` and both post: the guarantee is once per run and
 *   across sequential runs, not under simultaneous posters. Run `--post` from
 *   one place (the lifecycle tolerates the duplicate — the newest presentation
 *   decides — but the epic would carry two comments).
 * - One failed post does not abort the rest, and every failure is returned.
 */
export async function postSuspicions(
  report: FleetHealthReport,
  known: ReadonlyMap<string, EpicComments>,
  unknownEpics: ReadonlySet<string>,
  cfg: FleetHealthConfig,
  nowMs: number,
  deps: PostDeps,
): Promise<PostOutcome> {
  const out: PostOutcome = {
    posted: [],
    skipped: [],
    failed: [],
    refused: null,
  };
  if (Date.parse(report.window.until) < nowMs - DAY_MS) {
    out.refused =
      "the window ended in the past, so PRs that existed during it may be missing and a comment would rest on partial figures; post from a current window";
    return out;
  }
  if (report.gaps.length > 0) {
    out.refused = `the report is partial (${report.gaps.length} gap(s), the first: ${report.gaps[0]}) and a comment on an epic must rest on complete figures`;
    return out;
  }
  const due = presentable(
    report,
    new Map([...known].map(([e, c]) => [e, c.comments])),
    nowMs,
    cfg.lifecycle.cooldownDays,
    unknownEpics,
  );
  for (const t of due) {
    const target = `${t.kind}→${t.epic}`;
    try {
      const fresh = await deps.fetchEpicComments(t.epic);
      const l = deriveLifecycle(
        t.kind,
        fresh.comments,
        nowMs,
        cfg.lifecycle.cooldownDays,
      );
      if (l.state === "unknown") {
        out.skipped.push(`${target} (an unparsed diagnosis comment)`);
        continue;
      }
      if (l.state !== "new") {
        out.skipped.push(`${target} (now ${l.state})`);
        continue;
      }
      await deps.postComment(fresh.uuid, suspicionComment(t, report));
      out.posted.push(target);
    } catch (err) {
      out.failed.push({
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = [
  "usage: fleet-health.ts [--days N] [--until YYYY-MM-DD] [--limit N] [--concurrency N]",
  "                       [--json] [--out FILE] [--post]",
] as const;

export interface CliArgs extends RunOptions {
  json: boolean;
  out: string | null;
  post: boolean;
}

export function parseArgs(
  argv: ReadonlyArray<string>,
  todayMs: number,
  defaultDays: number,
): CliArgs {
  const args: CliArgs = {
    until: new Date(todayMs + DAY_MS).toISOString().slice(0, 10),
    days: defaultDays,
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
    out: null,
    post: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") args.json = true;
    else if (a === "--post") args.post = true;
    else if (a === "--days")
      args.days = positiveIntArg(a, argv[++i], 366, USAGE);
    else if (a === "--limit")
      args.limit = positiveIntArg(a, argv[++i], 5000, USAGE);
    else if (a === "--concurrency")
      args.concurrency = positiveIntArg(a, argv[++i], 16, USAGE);
    else if (a === "--until") {
      const d = calendarDate(argv[++i] ?? "");
      if (d === null)
        fail(2, "--until takes a real calendar date, YYYY-MM-DD", ...USAGE);
      args.until = d;
    } else if (a === "--out") {
      const f = argv[++i];
      if (f === undefined || f === "" || f.startsWith("--"))
        fail(2, "--out takes a file path", ...USAGE);
      args.out = f;
    } else fail(2, `unknown argument: ${a}`, ...USAGE);
  }
  return args;
}

/** The real dependencies: GitHub, the catalog, the issue tracker. Also used by a dashboard collector. */
export async function realDeps(
  cfg: FleetHealthConfig,
  note: (msg: string) => void,
): Promise<RunDeps> {
  const repo = await resolveRepo();
  let classifier: Classifier | null = null;
  let classifierError: string | null = null;
  try {
    classifier = await makeClassifier(cfg);
  } catch (err) {
    classifierError = err instanceof Error ? err.message : String(err);
  }
  let tracker: Tracker | null = null;
  let trackerError: string | null = null;
  try {
    tracker = connectTracker(cfg);
  } catch (err) {
    trackerError = err instanceof Error ? err.message : String(err);
  }
  const need = (): Tracker => {
    if (tracker === null)
      throw new Error(trackerError ?? "the issue tracker is unavailable");
    return tracker;
  };
  return {
    cfg,
    nowMs: () => Date.now(),
    budget: graphqlBudget,
    listCandidates: (w, limit) => listCandidatePrs(repo, w, limit),
    reviewedHeads: (n) => fetchReviewedHeads(repo, n),
    samplePr: (n, asOf) =>
      samplePr(n, repo, asOf === undefined ? {} : { asOf }),
    prFiles: (n) => fetchPrFiles(repo, n),
    prBody: (n) => fetchPrBody(repo, n),
    classifier,
    classifierError,
    tracker,
    trackerError,
    fetchIssues: (ids) => fetchIssuesByIds(need(), ids),
    fetchWindowIssues: (w) => fetchWindowIssues(need(), w, cfg.labels),
    fetchEpicActivity: (signal) =>
      fetchEpicActivity(need(), cfg.labels.epic, signal),
    fetchAcceptedEpics: (w) => fetchAcceptedEpics(need(), w, cfg.labels.epic),
    fetchEpicComments: (e) => fetchEpicComments(need(), e),
    note,
  };
}

async function main(): Promise<number> {
  const startMs = Date.now();
  let cfg: FleetHealthConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    return fail(
      1,
      `fleet-health: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const args = parseArgs(process.argv.slice(2), startMs, cfg.window.days);
  const deps = await realDeps(cfg, (m) => console.error(m));
  let result: RunResult;
  try {
    result = await runFleetHealth(args, { ...deps, nowMs: () => startMs });
  } catch (err) {
    if (err instanceof BudgetError)
      return fail(1, `fleet-health: ${err.message}`);
    throw err;
  }
  const { report, epicComments, unknownEpics } = result;

  const text = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderReport(report);
  if (args.out === null) process.stdout.write(text);
  else {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text);
    console.error(`fleet-health: wrote ${args.out}`);
  }

  const cooldown = cfg.lifecycle.cooldownDays;
  if (!args.post) {
    const targets = presentable(
      report,
      new Map([...epicComments].map(([e, c]) => [e, c.comments])),
      startMs,
      cooldown,
      unknownEpics,
    );
    if (targets.length > 0) {
      console.error(
        `fleet-health: ${targets.length} suspicion(s) would be commented on their epic with --post: ${targets
          .map((t) => `${t.kind}→${t.epic}`)
          .join(", ")}`,
      );
    }
    return report.gaps.length === 0 ? 0 : 3;
  }
  const tracker = deps.tracker;
  if (tracker === null) {
    console.error(
      `fleet-health: --post needs the issue tracker and it is unavailable (${deps.trackerError ?? "no port"}); nothing was posted`,
    );
    return 3;
  }
  const outcome = await postSuspicions(
    report,
    epicComments,
    unknownEpics,
    cfg,
    startMs,
    {
      postComment: (issue, body) => tracker.postComment(issue, body),
      fetchEpicComments: deps.fetchEpicComments,
    },
  );
  if (outcome.refused !== null) {
    console.error(`fleet-health: --post refused: ${outcome.refused}`);
    return 3;
  }
  console.error(
    `fleet-health: posted ${outcome.posted.length}${outcome.posted.length > 0 ? ` (${outcome.posted.join(", ")})` : ""}, skipped ${outcome.skipped.length}${outcome.skipped.length > 0 ? ` (${outcome.skipped.join(", ")})` : ""}, failed ${outcome.failed.length}`,
  );
  for (const f of outcome.failed) {
    console.error(`fleet-health: could not comment ${f.target}: ${f.error}`);
  }
  return outcome.failed.length === 0 ? 0 : 3;
}

if (import.meta.main) runMain("fleet-health", main);
