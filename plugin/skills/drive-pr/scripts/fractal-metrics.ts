#!/usr/bin/env bun
/**
 * fractal-metrics.ts — the cross-PR scoreboard for the fractal-SDLC program.
 *
 * Every other metric in this directory is per-PR (`loop-metrics.ts`,
 * `self-inflicted.ts`, `defect-escape.ts`, `verification-fit.ts`), so nothing
 * could say whether a change to the review loop is working except
 * anecdotally. This aggregates them over a window and judges each figure
 * against the consumer's recorded baseline (`baselines:` in the fleet-health
 * configuration), with a stated verdict per metric (improved / flat / worse,
 * or why there is none — see `lib/fractal-baseline.ts`).
 *
 * One command, both halves:
 *
 *   PR side     merged PRs in the window → bot-reviewed heads per PR (median,
 *               p90), accepted share by round band × severity, the share of
 *               threads raised after the first ladder band, and the
 *               share of threads raised on code written after review began
 *               (post-review "self-inflicted", temporal not causal), with its trend by week.
 *   Linear side (the issue tracker, through do-item's tracker port) the
 *               follow-up cohort created in the window (mints/day, open,
 *               closure share, priorityless share, median age), epic
 *               open/completed counts, and the debt ledger as context.
 *
 * Usage:
 *   fractal-metrics.ts [--pr-days N] [--days N] [--until YYYY-MM-DD]
 *                      [--limit N] [--concurrency N] [--json] [--out FILE]
 *                      [--skip-prs] [--skip-tracker]
 *                      [--skip-self-inflicted] [--no-fetch-heads]
 *
 *   --until D    the exclusive end of BOTH windows, default tomorrow (so today's
 *                merges are in). Pass it to reproduce a RECORDED window; the
 *                Linear side is then still "as of now" — see the caveat the
 *                report prints.
 *   --pr-days N  the PR-side window, default 7: what a run can afford — a busy
 *                repository merges hundreds of PRs a month, and each costs
 *                several GraphQL pages to sample, against GitHub's hourly
 *                budget. Half-open
 *                `[until - N days, until)`, UTC.
 *   --days N     the Linear cohort window, default 37. Window-bound verdicts
 *                assume the baselines were recorded over the same length.
 *   --limit N    most PRs sampled (default 300). A window past it is reported
 *                as capped, never silently truncated.
 *   --skip-prs / --skip-tracker  measure one half only. The baseline-window
 *                reproduction runs `--skip-tracker`, since tracker state
 *                cannot be rewound. `--skip-linear` is accepted as an alias
 *                of `--skip-tracker`.
 *   --skip-self-inflicted        skip the per-thread `git blame` pass, the
 *                slowest part of a PR-side run.
 *   --no-fetch-heads             do not `git fetch` each PR's `pull/N/head`;
 *                self-inflicted is then measured only where the head is
 *                already local, and its coverage says so.
 *
 * Exit codes:
 *   0  the scoreboard was produced in full
 *   1  the run could not start (config, listing, or window unreadable)
 *   2  usage error
 *   3  produced but PARTIAL — a requested half, or some PRs, could not be
 *      measured. The report is still printed, with the gap in its caveats, so
 *      a scheduled run cannot mistake a partial scoreboard for a clean one.
 *
 * A REPORTING tool: nothing acts on it and it mutates nothing on GitHub or in
 * Linear. Its `git fetch` writes objects only (`--no-write-fetch-head`, no
 * refs). Record a run's figures where the consumer keeps its baselines.
 */

import {
  conflictCoverage,
  CONFLICT_LIMITS,
  judgedConflictShare,
  observeConflicts,
  realConflictDeps,
  type ConflictObservation,
} from "./lib/fractal-conflicts.ts";
import { consumerRoot, remoteName } from "../../../shared/consumer.ts";
import { Defect } from "../../../shared/errors.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calendarDate, type MergedPr, mergedPrs } from "./defect-escape.ts";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import {
  readRecordedEscapeBaseline,
  renderEscapeAnchor,
} from "./lib/escape-baseline.ts";
import {
  aggregatePrSide,
  type BandLike,
  boundedMetricIds,
  buildPrRecord,
  currentValues,
  judgedLateRoundShare,
  judgedSelfInflictedShare,
  type LinearSide,
  MIN_SELF_INFLICTED_COVERAGE,
  metricRows,
  type PrRecord,
  renderScoreboard,
  type Scoreboard,
} from "./lib/fractal.ts";
import {
  baselineSourceProblems,
  METRICS,
  type MetricSpec,
  unknownBaselineIds,
  withBaselines,
} from "./lib/fractal-baseline.ts";
import {
  type FleetHealthConfig,
  loadConfig,
} from "./lib/fleet-health-config.ts";
import { fetchLinearSide, type LinearWindow } from "./lib/fractal-linear.ts";
import { initiatingBotReviews } from "./lib/metrics.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "./lib/proc.ts";
import {
  type PrSample,
  type Repo,
  resolveRepo,
  samplePr,
} from "./lib/sample.ts";
import { gitDeps, labelRecord } from "./self-inflicted.ts";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 37;
const DEFAULT_PR_DAYS = 7;
const DEFAULT_LIMIT = 300;
const DEFAULT_CONCURRENCY = 4;
/**
 * Linear metrics derived from the `--days` cohort (or the window itself): a run
 * at another length would credit or blame the window, not the program.
 */
const WINDOW_BOUND_LINEAR_METRICS = [
  "mints_per_day",
  "cohort_open",
  "cohort_closure_share",
  "priorityless_share",
  "parentless_open",
  "median_open_age_days",
  "epics_completed_in_window",
] as const;

export interface RunOptions {
  /** Exclusive end of the window, as `YYYY-MM-DD` (UTC midnight). */
  until: string;
  /** Linear cohort window length. */
  days: number;
  /** PR-side window length. */
  prDays: number;
  limit: number;
  concurrency: number;
  skipPrs: boolean;
  skipTracker: boolean;
}

export interface LadderShape {
  bands: BandLike[];
  severityOrder: string[];
}

export interface RunDeps {
  nowMs(): number;
  listMergedPrs(
    since: string,
    untilInclusive: string,
    limit: number,
  ): Promise<MergedPr[]>;
  samplePr(pr: number, asOf: string | undefined): Promise<PrSample>;
  /**
   * `threadId -> selfInflicted` for one PR's threads. Threads it cannot label
   * are simply absent (⇒ not measured). MUST NOT throw: a failure to blame is
   * a coverage loss, never a reason to lose the PR.
   */
  labelSelfInflicted:
    | ((sample: PrSample) => Promise<Map<string, boolean | null>>)
    | null;
  loadLadder(): Promise<LadderShape>;
  fetchLinear(win: LinearWindow): Promise<LinearSide>;
  note(msg: string): void;
  /** The metric catalogue to judge against; defaults to `METRICS`. */
  specs?: ReadonlyArray<MetricSpec>;
  conflictCoverageFloor?: number;
  observeConflicts?: (
    samples: readonly PrSample[],
    cohort: readonly MergedPr[],
  ) => Promise<Map<number, ConflictObservation>>;
}

export interface RunResult {
  scoreboard: Scoreboard;
  /** Non-empty ⇒ the scoreboard is partial (exit 3). */
  gaps: string[];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function mapLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Conflict collection is independent of review sampling coverage. */
async function measureConflicts(
  samples: readonly PrSample[],
  prs: readonly MergedPr[],
  deps: RunDeps,
  capped: boolean,
  gaps: string[],
  caveats: string[],
): Promise<Exclude<Scoreboard["mergeConflicts"], undefined>> {
  if (deps.observeConflicts === undefined) return null;
  let observations = new Map<number, ConflictObservation>();
  try {
    observations = await deps.observeConflicts(samples, prs);
  } catch (err) {
    gaps.push(
      `merge-conflict evidence unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const coverage = conflictCoverage(
    prs.map((p) => p.number),
    observations,
    deps.conflictCoverageFloor ?? 0.9,
  );
  coverage.cohortCapped = capped;
  if (capped) coverage.bounds = null;
  caveats.push(CONFLICT_LIMITS);
  if (judgedConflictShare(coverage, deps.specs ?? METRICS) === null)
    gaps.push(
      "merge-conflict verdict withheld: coverage is absent, below its floor, or unknown PRs could change the verdict",
    );
  return coverage;
}

/** Coverage bounds govern this row even when review figures are withheld. */
function publishConflictShare(
  coverage: Scoreboard["mergeConflicts"],
  specs: readonly MetricSpec[],
  values: Record<string, number | null>,
  bounded: Set<string>,
): void {
  if (!coverage) return;
  values.merge_conflict_share = judgedConflictShare(coverage, specs);
  if (coverage.unknown > 0) bounded.add("merge_conflict_share");
}

/**
 * Everything `main()` does after argv parsing — its own injectable function so
 * a test pins the REAL composition (window arithmetic → sampling → aggregation
 * → verdict rows) rather than a hand-rebuilt copy that would stay green if this
 * wiring changed underneath it.
 */
export async function runScoreboard(
  opts: RunOptions,
  deps: RunDeps,
): Promise<RunResult> {
  const nowMs = deps.nowMs();
  const untilMs = Date.parse(`${opts.until}T00:00:00Z`);
  const sinceMs = untilMs - opts.days * DAY_MS;
  const prSinceMs = untilMs - opts.prDays * DAY_MS;
  const gaps: string[] = [];
  const caveats: string[] = [
    "A round is the ordinal of the bot-reviewed head a thread was raised on — the same population `rounds.reviewedHeads` counts — not the drive’s own round counter, which is per-clone state and cannot be recovered retroactively. A thread whose head was rewritten away has no round and is counted under `unknown-round`.",
  ];

  let pr: Scoreboard["pr"] = null;
  let prsUnsampled = false;
  let prsCapped = false;
  let mergeConflicts: Scoreboard["mergeConflicts"] = null;
  if (!opts.skipPrs) {
    const ladder = await deps.loadLadder();
    // One more than asked for, so "the cap bound" is witnessed by an extra
    // result rather than inferred from `length === limit`.
    const listed = await deps.listMergedPrs(
      isoDate(prSinceMs),
      isoDate(untilMs - DAY_MS),
      opts.limit + 1,
    );
    const capped = listed.length > opts.limit;
    const prs = listed.slice(0, opts.limit);
    if (capped) {
      prsCapped = true;
      // The newest `--limit` PRs are a different population than the window.
      prsUnsampled = true;
      gaps.push(
        `window holds more than --limit ${opts.limit} merged PRs; the oldest were not sampled, so PR-side verdicts are withheld`,
      );
    }
    // Outcomes are frozen at the window's end when that end is in the past, so
    // a reply added after the window cannot rewrite a recorded window's mix.
    const asOf = untilMs <= nowMs ? new Date(untilMs).toISOString() : undefined;
    const failed: number[] = [];
    const samples: PrSample[] = [];
    const records = (
      await mapLimit(
        prs,
        opts.concurrency,
        async (p, i): Promise<PrRecord | null> => {
          deps.note(`prs: [${i + 1}/${prs.length}] #${p.number}`);
          try {
            const sample = await deps.samplePr(p.number, asOf);
            samples.push(sample);
            const labels =
              deps.labelSelfInflicted === null
                ? new Map<string, boolean | null>()
                : await deps.labelSelfInflicted(sample);
            return buildPrRecord(sample, ladder.bands, labels);
          } catch (err) {
            failed.push(p.number);
            deps.note(
              `prs: #${p.number} unreadable (${err instanceof Error ? err.message : String(err)})`,
            );
            return null;
          }
        },
      )
    ).filter((r): r is PrRecord => r !== null);
    if (failed.length > 0) {
      prsUnsampled = true;
      gaps.push(
        `${failed.length} PR(s) could not be sampled and are absent from the review figures, so review verdicts are withheld; conflict records can still cover them: ${failed
          .sort((a, b) => a - b)
          .map((n) => `#${n}`)
          .join(", ")}`,
      );
    }
    pr = aggregatePrSide(records, ladder.bands, ladder.severityOrder, {
      sinceMs: prSinceMs,
      untilMs,
    });
    mergeConflicts = await measureConflicts(
      samples,
      prs,
      deps,
      prsCapped,
      gaps,
      caveats,
    );
    // An empty population is a wrong window, not a quiet week: every PR-side
    // row would read `not-measured` under an exit code that claims a full run.
    if (pr.prs === 0) gaps.push("no merged PRs in the PR window");
    else if (pr.prsWithRounds === 0) {
      gaps.push("no PR in the window has a bot-reviewed head");
    }
    if (
      deps.labelSelfInflicted !== null &&
      pr.selfInflicted.eligible > 0 &&
      (pr.selfInflicted.coverage ?? 0) < MIN_SELF_INFLICTED_COVERAGE
    ) {
      gaps.push(
        `self-inflicted coverage is ${((pr.selfInflicted.coverage ?? 0) * 100).toFixed(1)}% of eligible threads, below the ${MIN_SELF_INFLICTED_COVERAGE * 100}% floor, so its verdict is withheld (fetched heads? \`--no-fetch-heads\`?)`,
      );
    }
    // Same predicate `currentValues` publishes with, so a withheld late-round
    // row always has a gap — including when no thread's round is recoverable
    // (`share` is then null and the interval test never runs).
    if (
      pr.threads.unknownRound > 0 &&
      judgedLateRoundShare(pr, deps.specs ?? METRICS) === null
    ) {
      gaps.push(
        `${pr.threads.unknownRound} thread(s) with no recoverable round could move the late-round verdict either way, so it is withheld`,
      );
    }
    if (
      deps.labelSelfInflicted !== null &&
      (pr.selfInflicted.coverage ?? 0) >= MIN_SELF_INFLICTED_COVERAGE &&
      pr.selfInflicted.share !== null &&
      judgedSelfInflictedShare(pr, deps.specs ?? METRICS) === null
    ) {
      gaps.push(
        `${pr.selfInflicted.eligible - pr.selfInflicted.measured} unmeasured thread(s) could move the self-inflicted verdict either way, so it is withheld`,
      );
    }
    if (
      deps.labelSelfInflicted !== null &&
      pr.prsWithRounds > 0 &&
      pr.selfInflicted.eligible === 0
    ) {
      gaps.push(
        "no thread was raised after the first reviewed head, so self-inflicted has no population and reads not-measured",
      );
    }
    if (deps.labelSelfInflicted === null) {
      caveats.push("Self-inflicted was skipped (`--skip-self-inflicted`).");
    }
  }

  let linear: LinearSide | null = null;
  if (!opts.skipTracker) {
    try {
      linear = await deps.fetchLinear({ sinceMs, untilMs, nowMs });
    } catch (err) {
      gaps.push(
        `the Linear side could not be measured: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (linear !== null && untilMs < nowMs - DAY_MS) {
      caveats.push(
        "The Linear side is AS OF NOW: only the cohort’s creation window is historical. Issue `statusType` keeps changing after a window closes, so a past window’s open/closed split is not reproducible.",
      );
    }
  }

  const sides = new Set<"pr" | "linear">();
  if (!opts.skipPrs) sides.add("pr");
  if (!opts.skipTracker) sides.add("linear");
  const specs = deps.specs ?? METRICS;
  const values = currentValues(pr, linear, specs);
  // A PR that could not be sampled is missing from every PR-side aggregate, so
  // a median, p90 or share over the rest is a different population than the
  // baseline's. Withhold those verdicts; the partial counts stay in `pr`.
  if (prsUnsampled) {
    for (const spec of specs) if (spec.side === "pr") values[spec.id] = null;
  }
  // The Linear count baselines were recorded over one cohort window; a run at
  // another length would credit or blame the window itself, not the program.
  if (linear !== null && opts.days !== DEFAULT_DAYS) {
    for (const id of WINDOW_BOUND_LINEAR_METRICS) values[id] = null;
    caveats.push(
      `--days ${opts.days} differs from the ${DEFAULT_DAYS}-day window the Linear baselines were recorded over, so window-bound Linear verdicts are withheld.`,
    );
  }
  const bounded = boundedMetricIds(pr, specs);
  publishConflictShare(mergeConflicts, specs, values, bounded);
  const metrics = metricRows(sides, values, specs, bounded);
  for (const m of metrics) {
    if (m.verdict === "no-baseline") {
      caveats.push(
        `No recorded baseline for "${m.label}" — this measurement is the first data point, so it carries no verdict.`,
      );
    }
  }
  if (linear !== null) {
    caveats.push(
      "Open and completed epics are compared as separate counts against their own baselines.",
    );
  }

  return {
    gaps,
    scoreboard: {
      version: 1,
      generatedAt: new Date(nowMs).toISOString(),
      window: {
        until: new Date(untilMs).toISOString(),
        pr: { since: new Date(prSinceMs).toISOString(), days: opts.prDays },
        linear: { since: new Date(sinceMs).toISOString(), days: opts.days },
      },
      pr,
      mergeConflicts,
      linear,
      metrics,
      escapeAnchor: renderEscapeAnchor(null).trim(),
      caveats: [...gaps.map((g) => `PARTIAL: ${g}`), ...caveats],
    },
  };
}

// ── Real dependencies ───────────────────────────────────────────────────────

async function loadLadder(): Promise<LadderShape> {
  // Dynamically imported for the reason `defect-escape.ts --ladder-only` does:
  // a drive-pr copy installed without its sibling skill must still run every
  // mode that does not need it. This one does — bands are what the round cut
  // is made of — so its absence is a loud refusal, not a default.
  let mod: typeof import("../../resolve-review-comments/scripts/lib/ladder.ts");
  try {
    mod = await import("../../resolve-review-comments/scripts/lib/ladder.ts");
  } catch (err) {
    return fail(
      1,
      `fractal-metrics: the resolve-review-comments skill's ladder module could not be loaded (${err instanceof Error ? err.message : String(err)}).`,
      'Its `bands:` are what "round band" means here; refusing to invent a cut.',
    );
  }
  const r = await mod.loadLadder(mod.defaultConfigPath());
  if (r.config === null) {
    return fail(
      1,
      `fractal-metrics: the ladder config is unusable (${r.anomaly}).`,
      "Refusing to bucket rounds without its `bands:`.",
    );
  }
  return { bands: r.config.bands, severityOrder: r.config.severityOrder };
}

async function repoRoot(): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], {
    env: gitIdentityEnv(),
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (r.code !== 0) fail(1, "fractal-metrics: not inside a git repository");
  return r.stdout.trim();
}

/**
 * Label each thread of one merged PR with whether its anchor line was written
 * AFTER review began — the retroactive, temporal reading of "self-inflicted" (planned work and CI repairs land in it too).
 *
 * NOT `self-inflicted.ts`'s question, deliberately. That asks whether the line
 * was written by ANY of the PR's own commits, and an inline review comment
 * anchors on a line the PR's diff changed, so the answer is almost always yes:
 * measured on the recorded baseline window it is 93% in every round band, a
 * saturated figure that cannot show a trend. The question the ladder and FB-74
 * care about is narrower — is this a finding against a line a PRIOR ROUND's fix
 * wrote — so the PR's "own" commits here are those made after the first bot
 * review: `rev-list <head> ^<firstReviewedHead> ^<base>`.
 *
 * Consequences, each stated so the figure is not over-read:
 *  - a round-1 thread is EXCLUDED, not `false`: no fix preceded it;
 *  - the thread is blamed at its own `reviewedHeadOid` on its `originalLine`,
 *    which addressed the same tree by construction, so an outdated thread —
 *    `null` for the live labeller, whose `line` no longer addresses HEAD — is
 *    measurable here;
 *  - `base` is `mergeCommit^1`, the tip the base branch had immediately before
 *    the PR landed (the same fixed referent `loop-metrics.ts` uses), which also
 *    keeps commits imported by merging the base out of the set;
 *  - the first reviewed head must be an ancestor of the thread's head. A
 *    force-push that rewrote it makes "after review began" unanswerable, so
 *    the thread is left unmeasured rather than guessed;
 *  - a LEFT-side anchor numbers the pre-image, so it is left unmeasured exactly
 *    as `self-inflicted.ts` refuses it;
 *  - a multi-line comment is blamed on its END line only (`ThreadSample` does
 *    not carry the range's start), so a post-review line earlier in the range
 *    is missed and the share is a LOWER BOUND — the same in the baseline and
 *    in every re-measure, so the comparison holds even where the level does not.
 *
 * Anything git cannot answer leaves the thread unmeasured, never `false`.
 */
export function makeSelfInflictedLabeler(
  repo: string,
  fetchHeads: boolean,
  note: (msg: string) => void = () => undefined,
): (sample: PrSample) => Promise<Map<string, boolean | null>> {
  const opts = {
    cwd: repo,
    env: gitIdentityEnv(),
    stderr: "ignore" as const,
    timeoutSec: gitCallTimeoutSeconds(),
  };
  const remote = remoteName(consumerRoot(repo));
  const fetchedRefs = new Map<string, Promise<void>>();
  const fetchOnce = (key: string, args: string[]): Promise<void> => {
    let p = fetchedRefs.get(key);
    if (p === undefined) {
      p = git(
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--quiet",
          remote,
          ...args,
        ],
        opts,
      ).then((r) => {
        // A failed fetch is a coverage loss the run must be able to see: the
        // PR's raw commits are then unreachable and its threads unmeasured.
        if (r.code !== 0) {
          note(`self-inflicted: git fetch ${args.join(" ")} failed`);
        }
      });
      fetchedRefs.set(key, p);
    }
    return p;
  };

  /** Commits made after `first` and not part of `base`, or `null` if unanswerable. */
  async function postReviewCommits(
    first: string,
    head: string,
    base: string,
  ): Promise<Set<string> | null> {
    const anc = await git(["merge-base", "--is-ancestor", first, head], opts);
    if (anc.code !== 0) return null;
    const r = await git(["rev-list", head, `^${first}`, `^${base}`], opts);
    if (r.code !== 0) return null;
    return new Set(
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    );
  }

  return async (sample) => {
    const out = new Map<string, boolean | null>();
    try {
      const first = initiatingBotReviews(sample.reviews)[0]?.oid;
      if (first === undefined || sample.mergeCommitOid === "") return out;
      const eligible = sample.threads.filter(
        (t) =>
          t.path !== null &&
          t.originalLine !== null &&
          t.reviewedHeadOid !== null &&
          t.reviewedHeadOid !== first &&
          t.diffSide === "RIGHT",
      );
      if (eligible.length === 0) return out;
      if (fetchHeads) {
        // The base branch (once per branch name) so `mergeCommit^1` is local,
        // and this PR's own head so its raw commits are reachable at all — a
        // squash-merged branch's commits are otherwise unreachable.
        if (sample.baseRefName !== "") {
          await fetchOnce(`base:${sample.baseRefName}`, [sample.baseRefName]);
        }
        await fetchOnce(`pull:${sample.pr}`, [`pull/${sample.pr}/head`]);
      }
      const base = `${sample.mergeCommitOid}^1`;
      const perHead = new Map<
        string,
        {
          commits: Set<string> | null;
          blame: ReturnType<typeof gitDeps>["blame"];
        }
      >();
      for (const t of eligible) {
        const head = t.reviewedHeadOid as string;
        let entry = perHead.get(head);
        if (entry === undefined) {
          entry = {
            commits: await postReviewCommits(first, head, base),
            blame: gitDeps(repo, base, head).blame,
          };
          perHead.set(head, entry);
        }
        const label = await labelRecord(
          {
            path: t.path,
            line: t.originalLine,
            isOutdated: false,
            diffSide: "RIGHT",
            comments: [],
          },
          entry.commits,
          entry.blame,
        );
        if (label.selfInflicted !== null) {
          out.set(t.threadId, label.selfInflicted);
        }
      }
    } catch (err) {
      // Coverage loss, not a lost PR: whatever was labelled before the failure
      // stays, and the rest read as not measured — but said aloud, so a
      // programming error is not indistinguishable from an unfetchable head.
      note(
        `self-inflicted: PR #${sample.pr} labelling stopped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return out;
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = [
  "usage: fractal-metrics.ts [--pr-days N] [--days N] [--until YYYY-MM-DD] [--limit N]",
  "                          [--concurrency N] [--json] [--out FILE] [--skip-prs] [--skip-tracker]",
  "                          [--skip-self-inflicted] [--no-fetch-heads]",
] as const;

function positiveInt(
  flag: string,
  raw: string | undefined,
  max: number,
): number {
  if (raw === undefined || !isDigits(raw))
    fail(2, `${flag} takes a whole number`, ...USAGE);
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    fail(2, `${flag} must be between 1 and ${max}`, ...USAGE);
  }
  return n;
}

export interface CliArgs extends RunOptions {
  json: boolean;
  out: string | null;
  skipSelfInflicted: boolean;
  fetchHeads: boolean;
}

export function parseArgs(
  argv: ReadonlyArray<string>,
  todayMs: number,
): CliArgs {
  const args: CliArgs = {
    until: isoDate(todayMs + DAY_MS),
    days: DEFAULT_DAYS,
    prDays: DEFAULT_PR_DAYS,
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    skipPrs: false,
    skipTracker: false,
    json: false,
    out: null,
    skipSelfInflicted: false,
    fetchHeads: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") args.json = true;
    else if (a === "--skip-prs") args.skipPrs = true;
    else if (a === "--skip-tracker" || a === "--skip-linear")
      args.skipTracker = true;
    else if (a === "--skip-self-inflicted") args.skipSelfInflicted = true;
    else if (a === "--no-fetch-heads") args.fetchHeads = false;
    else if (a === "--days") args.days = positiveInt(a, argv[++i], 366);
    else if (a === "--pr-days") args.prDays = positiveInt(a, argv[++i], 366);
    else if (a === "--limit") args.limit = positiveInt(a, argv[++i], 5000);
    else if (a === "--concurrency")
      args.concurrency = positiveInt(a, argv[++i], 16);
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
  if (args.skipPrs && args.skipTracker)
    fail(2, "--skip-prs and --skip-tracker leave nothing to measure", ...USAGE);
  return args;
}

/** Real conflict probes share the resolved repository and configured floor. */
function conflictInputs(
  root: string,
  repo: Repo | null,
  cfg: FleetHealthConfig | null,
): Pick<RunDeps, "conflictCoverageFloor" | "observeConflicts"> {
  return {
    conflictCoverageFloor: cfg?.mergeConflicts.coverageFloor ?? 0.9,
    observeConflicts: async (samples, cohort) => {
      if (repo === null) throw new Defect("no repository resolved");
      return observeConflicts(
        samples,
        realConflictDeps(root, repo, (message) => console.error(message)),
        cohort,
      );
    },
  };
}

async function main(): Promise<number> {
  // One read feeds both the default window end and every `nowMs` below, so a
  // UTC-midnight crossing mid-run cannot make them disagree.
  const startMs = Date.now();
  const args = parseArgs(process.argv.slice(2), startMs);
  const repo = args.skipPrs ? null : await resolveRepo();
  const root = args.skipPrs ? "" : await repoRoot();
  const labeler =
    args.skipPrs || args.skipSelfInflicted
      ? null
      : makeSelfInflictedLabeler(root, args.fetchHeads, (m) =>
          console.error(m),
        );

  // The consumer's configuration supplies the recorded baselines and the
  // tracker vocabulary; without it the PR side still runs, with no verdicts.
  let cfg: FleetHealthConfig | null = null;
  let cfgError = "";
  try {
    cfg = loadConfig();
  } catch (err) {
    cfgError = err instanceof Error ? err.message : String(err);
    console.error(
      `fractal-metrics: no fleet-health configuration (${cfgError}); no baseline is applied`,
    );
  }
  const specs =
    cfg === null ? [...METRICS] : withBaselines(METRICS, cfg.baselines);
  if (cfg !== null) {
    for (const id of unknownBaselineIds(cfg.baselines))
      console.error(
        `fractal-metrics: baselines.${id} names no metric this scoreboard measures`,
      );
    for (const problem of baselineSourceProblems(specs, cfg.root ?? root))
      console.error(`fractal-metrics: baseline source drifted: ${problem}`);
  }

  const { scoreboard, gaps } = await runScoreboard(args, {
    specs,
    ...conflictInputs(root, repo, cfg),
    nowMs: () => startMs,
    listMergedPrs: (since, untilInclusive, limit) =>
      mergedPrs(since, untilInclusive, limit),
    samplePr: (n, asOf) => {
      // Only reached on the PR side, which `--skip-prs` never enters.
      if (repo === null) throw new Error("no repository resolved (--skip-prs)");
      return samplePr(n, repo, asOf === undefined ? {} : { asOf });
    },
    labelSelfInflicted: labeler,
    loadLadder,
    fetchLinear: async (win) => {
      if (cfg === null) throw new Error(cfgError);
      return fetchLinearSide(win, (m) => console.error(m), cfg);
    },
    note: (m) => console.error(m),
  });

  scoreboard.escapeAnchor = renderEscapeAnchor(
    readRecordedEscapeBaseline(root),
  ).trim();
  const text = args.json
    ? `${JSON.stringify(scoreboard, null, 2)}\n`
    : renderScoreboard(scoreboard);
  if (args.out === null) process.stdout.write(text);
  else {
    // The documented monthly target is under the gitignored `.context/`, which
    // a fresh checkout does not have — without this the write fails after sampling.
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text);
    console.error(`fractal-metrics: wrote ${args.out}`);
  }
  return gaps.length === 0 ? 0 : 3;
}

if (import.meta.main) runMain("fractal-metrics", main);
