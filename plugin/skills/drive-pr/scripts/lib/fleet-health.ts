/**
 * The fleet-health sensor's pure core: from facts already
 * read off GitHub and the issue tracker to per-epic ceremony/progress figures, the
 * signals, and each signal's lifecycle position.
 *
 * Pure on purpose — no clock, no network, no filesystem. `fleet-health.ts`
 * (the command) and `lib/fleet-health-sources.ts` (the I/O) feed it; the
 * dashboard collector and the drive brief consume its output. That split is
 * what lets known positives (a two-deep follow-up chain, a review carousel)
 * be pinned as fixtures rather than only re-observed live.
 *
 * ── What a signal is, and is not ───────────────────────────────────────────
 *
 * A threshold crossed is a SUSPICION. The sensor never confirms a pathology on
 * counts alone: `established` exists only as a disposition an epic's owner
 * records in a diagnosis comment (see `DISPOSITIONS`), and a
 * suspicion whose diagnosis closes it cannot re-present until its cooldown
 * ends, so the sensor cannot become its own ceremony. Nothing here pages anyone; the
 * durable address for an epic-scoped signal is a comment on that epic.
 *
 * Every figure is a figure over what could be MEASURED. A unit the sensor
 * cannot see (`ceremony.unmeasured` in the config) is reported as a gap, never
 * as zero, and a ratio is therefore a lower bound on ceremony.
 */

import {
  CLOSED_STATE_TYPES,
  type CommentFact,
  type IssueFact,
  type StartedIssueActivity,
  type WindowSpec,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import type { FleetHealthConfig } from "./fleet-health-config.ts";

/** The tracker facts the sensor reads, as the tracker port defines them. */
export type { CommentFact, IssueFact, WindowSpec };
/** A started epic and the last activity on each child. */
export type EpicActivityFact = StartedIssueActivity;

export const SIGNAL_KINDS = [
  "stuck-epic",
  "finished-but-open",
  "tail-blocked",
  "orphan-risk",
  "ceremony-ratio",
  "followup-depth",
  "review-carousel",
  "delivery-system-share",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Kinds whose lifecycle is recorded on an epic (the rest are PR-level or
 * org-level, or the epic census: a census signal states a fact about the
 * epic's current shape, not a suspicion a diagnosis closes, and the census
 * never comments on an epic).
 */
export const EPIC_LIFECYCLE_KINDS: readonly SignalKind[] = [
  "stuck-epic",
  "ceremony-ratio",
  "followup-depth",
];

/** The epic census: facts about an epic's current shape, reported apart from the suspicions. */
export const EPIC_CENSUS_KINDS: readonly SignalKind[] = [
  "finished-but-open",
  "tail-blocked",
  "orphan-risk",
];

export type Severity = "elevated" | "high" | "maximum";

const DAY_MS = 86_400_000;

// ── Facts ──────────────────────────────────────────────────────────────────

/** Everything the sensor needs to know about one PR. */
export interface PrFact {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  /** Issue keys named by Closes/References trailers in the PR body. */
  issueRefs: string[];
  /** `submittedAt` of each bot-reviewed head, in round order (index + 1 = round). */
  rounds: string[];
  /** Post-review churn share (`lib/metrics.ts`) — TEMPORAL, not causal. `null` = not measured. */
  postReviewShare: number | null;
  postReviewAdditions: number;
  openingAdditions: number;
  threads: { total: number; answered: number; accepted: number };
  /**
   * Whether the merged diff touches a product area, `null` when it could not be
   * classified (not merged, or the change-area catalog was unavailable).
   */
  productPr: boolean | null;
}

export interface DeliveryFact {
  /** Added + deleted lines across merged PRs in the window. */
  totalLines: number;
  /** Lines in files a delivery-system change area claims. */
  deliveryLines: number;
  /**
   * Lines under `.claude/skills/**` no delivery-system area claims: a
   * KNOWN undercount, published so the share is a lower bound with a stated
   * upper bound instead of a number that reads as complete.
   */
  unclaimedSkillLines: number;
  prs: number;
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** The default follow-up label, when a caller names none. */
export const DEFAULT_FOLLOWUP_LABEL = "follow-up";
/** The default epic label, when a caller names none. */
export const DEFAULT_EPIC_LABEL = "epic";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One issue key: of `teamKey`, or of any team when it is `null`. */
function keySource(teamKey: string | null): string {
  return teamKey === null ? "[A-Z][A-Z0-9]*-\\d+" : `${escapeRe(teamKey)}-\\d+`;
}

function trailerPattern(teamKey: string | null): RegExp {
  const key = keySource(teamKey);
  return new RegExp(
    `\\b(?:closes?|closed|fix(?:es|ed)?|resolves?|resolved|references?|refs?)\\b:?\\s+((?:${key})(?:(?:\\s*(?:,|&|\\band\\b)\\s*|\\s+)${key})*)`,
    "gi",
  );
}

/**
 * Issue keys named by Closes/References trailers anywhere in `text` (of
 * `teamKey`, or of any team when it is `null`). Anywhere,
 * not line-start: the batch PRs this sensor most needs to read put the trailer
 * in a table cell (`| Closes ENG-123 | …`), and a start-anchored pattern would
 * attribute them to no epic at all.
 */
export function parseIssueRefs(
  text: string,
  teamKey: string | null = null,
): string[] {
  const out = new Set<string>();
  const key = new RegExp(keySource(teamKey), "gi");
  for (const m of text.matchAll(trailerPattern(teamKey))) {
    for (const id of (m[1] as string).matchAll(key)) {
      out.add(id[0].toUpperCase());
    }
  }
  return [...out];
}

const PR_IN_TITLE = /^PR #(\d{1,7})\s/;
const PR_IN_BODY =
  /(?:\/pull\/|\bPR\s+(?:[\w.-]+\/[\w.-]+)?#|\bpull request\s+(?:[\w.-]+\/[\w.-]+)?#|[\w.-]+\/[\w.-]+#)(\d{3,7})\b/i;

/**
 * The PR a follow-up issue was raised on. The deferral protocol batches
 * minor follow-ups into `PR #N <type> review follow-ups` (the title is the
 * durable key); a substantive one carries its origin in its description.
 * `null` when neither says.
 */
export function originPrOf(issue: {
  title: string;
  description: string;
}): number | null {
  const t = PR_IN_TITLE.exec(issue.title);
  const m = t ?? PR_IN_BODY.exec(issue.description);
  if (m === null) return null;
  const n = Number.parseInt(m[1] as string, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The epic an issue counts toward: itself when it IS an epic, else its nearest
 * epic ancestor. A trailer that names the epic directly ("References: ENG-100")
 * is attribution intent — an epic never produces a PR itself, so a PR that names
 * one is work toward it — and dropping it would charge that PR's review rounds
 * to no epic at all.
 */
export function epicOf(
  issue: Pick<IssueFact, "id" | "labels" | "ancestors">,
  epicLabel: string = DEFAULT_EPIC_LABEL,
): string | null {
  if (issue.labels.includes(epicLabel)) return issue.id;
  for (const a of issue.ancestors) {
    if (a.labels.includes(epicLabel)) return a.id;
  }
  return null;
}

// ── Units per epic ─────────────────────────────────────────────────────────

export interface EpicUnits {
  epic: string;
  progress: {
    mergedProductPrs: number[];
    criteriaClosed: string[];
    accepted: boolean;
    weighted: number;
  };
  ceremony: {
    /** PR number → rounds past `free_rounds` whose review landed in the window. */
    roundsBeyondFree: Array<{ pr: number; rounds: number }>;
    followupsMinted: string[];
    sdlcIssuesOpened: string[];
    weighted: number;
  };
}

export interface UnitsInput {
  cfg: FleetHealthConfig;
  window: WindowSpec;
  prs: ReadonlyArray<PrFact>;
  /** Every issue a PR trailer names, by id — the attribution lookup. */
  issues: ReadonlyMap<string, IssueFact>;
  /** Follow-up issues created in the window. */
  followups: ReadonlyArray<IssueFact>;
  /** Delivery-system issues created in the window. */
  sdlcIssues: ReadonlyArray<IssueFact>;
  /** Issues that reached `completed` in the window. */
  completed: ReadonlyArray<IssueFact>;
  /** Epics with an ACCEPT / ACCEPT-WITH-FOLLOWUPS verdict comment in the window. */
  acceptedEpics: ReadonlySet<string>;
}

export function inWindow(iso: string | null, w: WindowSpec): boolean {
  if (iso === null) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= w.sinceMs && ms < w.untilMs;
}

/** The epics a PR is attributed to: the epic of EVERY issue its trailers name. */
export function epicsOfPr(
  pr: Pick<PrFact, "issueRefs">,
  issues: ReadonlyMap<string, IssueFact>,
  epicLabel: string = DEFAULT_EPIC_LABEL,
): string[] {
  const out = new Set<string>();
  for (const ref of pr.issueRefs) {
    const issue = issues.get(ref);
    if (issue === undefined) continue;
    const epic = epicOf(issue, epicLabel);
    if (epic !== null) out.add(epic);
  }
  return [...out].sort();
}

export function computeEpicUnits(input: UnitsInput): Map<string, EpicUnits> {
  const { cfg, window: w } = input;
  const epicLabel = cfg.labels.epic;
  const byEpic = new Map<string, EpicUnits>();
  const unitsFor = (epic: string): EpicUnits => {
    let u = byEpic.get(epic);
    if (u === undefined) {
      u = {
        epic,
        progress: {
          mergedProductPrs: [],
          criteriaClosed: [],
          accepted: false,
          weighted: 0,
        },
        ceremony: {
          roundsBeyondFree: [],
          followupsMinted: [],
          sdlcIssuesOpened: [],
          weighted: 0,
        },
      };
      byEpic.set(epic, u);
    }
    return u;
  };

  for (const pr of input.prs) {
    const epics = epicsOfPr(pr, input.issues, epicLabel);
    if (epics.length === 0) continue;
    if (
      pr.state === "MERGED" &&
      inWindow(pr.mergedAt, w) &&
      pr.productPr === true
    ) {
      for (const e of epics)
        unitsFor(e).progress.mergedProductPrs.push(pr.number);
    }
    const beyond = pr.rounds.filter(
      (at, i) => i + 1 > cfg.ceremony.freeRounds && inWindow(at, w),
    ).length;
    if (beyond > 0) {
      for (const e of epics)
        unitsFor(e).ceremony.roundsBeyondFree.push({
          pr: pr.number,
          rounds: beyond,
        });
    }
  }
  for (const issue of input.followups) {
    const e = epicOf(issue, epicLabel);
    if (e !== null && inWindow(issue.createdAt, w))
      unitsFor(e).ceremony.followupsMinted.push(issue.id);
  }
  // An issue that is both a follow-up and a delivery-system issue is ONE piece of
  // ceremony, counted once (as the follow-up) — the two plan units overlap, and
  // charging an epic twice for the same issue would inflate every ratio.
  const followupIds = new Set(input.followups.map((i) => i.id));
  for (const issue of input.sdlcIssues) {
    const e = epicOf(issue, epicLabel);
    // An epic itself is not ceremony inside its own tree (nor is a follow-up
    // already counted above).
    if (
      e !== null &&
      !issue.labels.includes(epicLabel) &&
      !followupIds.has(issue.id) &&
      inWindow(issue.createdAt, w)
    ) {
      unitsFor(e).ceremony.sdlcIssuesOpened.push(issue.id);
    }
  }
  for (const issue of input.completed) {
    if (
      (cfg.labels.followup !== null &&
        issue.labels.includes(cfg.labels.followup)) ||
      issue.labels.includes(epicLabel)
    )
      continue;
    const e = epicOf(issue, epicLabel);
    if (
      e !== null &&
      issue.stateType === "completed" &&
      inWindow(issue.completedAt, w)
    ) {
      unitsFor(e).progress.criteriaClosed.push(issue.id);
    }
  }
  for (const epic of input.acceptedEpics)
    unitsFor(epic).progress.accepted = true;

  const { progress: pw } = cfg;
  const { ceremony: cw } = cfg;
  for (const u of byEpic.values()) {
    u.progress.mergedProductPrs = [
      ...new Set(u.progress.mergedProductPrs),
    ].sort((a, b) => a - b);
    u.progress.weighted =
      u.progress.mergedProductPrs.length * pw.weights.mergedProductPr +
      u.progress.criteriaClosed.length * pw.weights.criterionClosed +
      (u.progress.accepted ? pw.weights.epicAccepted : 0);
    u.ceremony.weighted =
      u.ceremony.roundsBeyondFree.reduce((s, r) => s + r.rounds, 0) *
        cw.weights.roundsBeyondFree +
      u.ceremony.followupsMinted.length * cw.weights.followupsMinted +
      u.ceremony.sdlcIssuesOpened.length * cw.weights.sdlcIssuesOpened;
  }
  return byEpic;
}

/**
 * Ceremony that names no epic: review rounds past the free ones on a PR that
 * names no epic-parented issue, and follow-up / delivery-system issues with no
 * epic ancestor (a parentless follow-up is filed by protocol). Counted so the
 * ratios' numerators are not silently narrower than the activity behind them.
 */
export function unattributedCeremony(input: UnitsInput): number {
  const { cfg, window: w } = input;
  let n = 0;
  for (const pr of input.prs) {
    if (epicsOfPr(pr, input.issues, cfg.labels.epic).length > 0) continue;
    n += pr.rounds.filter(
      (at, i) => i + 1 > cfg.ceremony.freeRounds && inWindow(at, w),
    ).length;
  }
  const seen = new Set<string>();
  for (const issue of [...input.followups, ...input.sdlcIssues]) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    if (epicOf(issue, cfg.labels.epic) === null && inWindow(issue.createdAt, w))
      n++;
  }
  return n;
}

// ── Signals ────────────────────────────────────────────────────────────────

export type SignalScope =
  | { type: "epic"; epic: string }
  | { type: "pr"; pr: number; epics: string[] }
  | { type: "org" };

export interface Signal {
  kind: SignalKind;
  scope: SignalScope;
  /** `null` = reported but not raised (no threshold crossed, or none configured). */
  severity: Severity | null;
  headline: string;
  evidence: string[];
  /** The measured figure; `null` when it is undefined (ratio against zero progress). */
  value: number | null;
  /** Stable identity, so a lifecycle and a cooldown can find the same signal again. */
  fingerprint: string;
  lifecycle: Lifecycle | null;
}

export function fingerprintOf(kind: SignalKind, scope: SignalScope): string {
  switch (scope.type) {
    case "epic":
      return `${kind}:${scope.epic}`;
    case "pr":
      return `${kind}:pr-${scope.pr}`;
    case "org":
      return `${kind}:org`;
  }
}

export function ceremonyRatioSignal(
  u: EpicUnits,
  cfg: FleetHealthConfig,
): Signal | null {
  const c = u.ceremony.weighted;
  const p = u.progress.weighted;
  // Zero ceremony and zero progress: an epic with no activity in the window is
  // not a fleet-health signal.
  if (c === 0 && p === 0) return null;
  const { suspectAt, highAt, minCeremony } = cfg.signals.ceremonyRatio;
  const scope: SignalScope = { type: "epic", epic: u.epic };
  const parts = [
    ...u.ceremony.roundsBeyondFree.map(
      (r) => `#${r.pr} ×${r.rounds} round(s) past ${cfg.ceremony.freeRounds}`,
    ),
    ...(u.ceremony.followupsMinted.length > 0
      ? [
          `${u.ceremony.followupsMinted.length} follow-up(s) minted (${u.ceremony.followupsMinted.join(", ")})`,
        ]
      : []),
    ...(u.ceremony.sdlcIssuesOpened.length > 0
      ? [
          `${u.ceremony.sdlcIssuesOpened.length} delivery-system issue(s) opened (${u.ceremony.sdlcIssuesOpened.join(", ")})`,
        ]
      : []),
  ];
  const progressParts = [
    ...(u.progress.mergedProductPrs.length > 0
      ? [
          `${u.progress.mergedProductPrs.length} product PR(s) merged (${u.progress.mergedProductPrs.map((n) => `#${n}`).join(", ")})`,
        ]
      : []),
    ...(u.progress.criteriaClosed.length > 0
      ? [
          `${u.progress.criteriaClosed.length} issue(s) closed (${u.progress.criteriaClosed.join(", ")})`,
        ]
      : []),
    ...(u.progress.accepted ? ["epic accepted"] : []),
  ];
  const evidence = [
    `ceremony ${c}: ${parts.join("; ") || "none"}`,
    `progress ${p}: ${progressParts.join("; ") || "none"}`,
    `lower bound on ceremony — not measured: ${Object.keys(cfg.ceremony.unmeasured).join(", ")}`,
  ];
  let severity: Severity | null = null;
  let value: number | null;
  let headline: string;
  if (p === 0) {
    // Nonzero ceremony against zero progress is the stalled or ceremony-only
    // epic the signal exists to catch; the ratio is undefined, so it raises at
    // maximum severity rather than propagating NaN/Infinity.
    value = null;
    severity = c >= minCeremony ? "maximum" : null;
    headline = `${c} ceremony unit(s), no progress`;
  } else {
    value = c / p;
    if (c >= minCeremony) {
      severity =
        value >= highAt ? "high" : value >= suspectAt ? "elevated" : null;
    }
    headline = `ceremony/progress ${value.toFixed(2)} (${c}/${p})`;
  }
  return {
    kind: "ceremony-ratio",
    scope,
    severity,
    headline,
    evidence,
    value,
    fingerprint: fingerprintOf("ceremony-ratio", scope),
    lifecycle: null,
  };
}

export interface DepthResult {
  depth: number;
  /** PR numbers, newest first: the PR itself, then each origin. */
  chain: number[];
  /**
   * The walk stopped before reaching a PR that closes no follow-up, because
   * something that SHOULD have been readable was not: an unreadable PR, an
   * issue the tracker could not resolve, or the `maxWalk` limit. A degradation.
   */
  truncated: boolean;
  /**
   * The walk met a follow-up issue that names no originating PR (a follow-up
   * filed from an issue rather than from a review thread), so the chain
   * necessarily ends there. Not a failure to read — the lineage is simply not
   * recorded — so it is a standing caveat with a count, never a gap: as a gap it
   * would put every run into `partial` for ever and make `--post` unusable.
   */
  originless: boolean;
}

export interface DepthDeps {
  /**
   * The issues a PR's trailers name, or `null` when they cannot be read.
   * `complete: false` means at least one named issue could not be resolved, so
   * the walk through this PR is a lower bound.
   */
  issuesOfPr(
    pr: number,
  ): Promise<{ issues: IssueFact[]; complete: boolean } | null>;
  /** The label a follow-up issue carries; default `follow-up`. */
  followupLabel?: string;
}

/**
 * Follow-up generation depth of one PR: follow a follow-up issue it closes to
 * the PR the issue was raised on, and that PR's issues to their own origin,
 * counting links. A PR that closes no follow-up issue has depth 0.
 *
 * Several follow-ups on one PR may point at different origins; the deepest
 * lineage wins, so the chain names the worst one rather than the first. Several
 * pointing at the SAME origin (the ordinary batch shape) are walked once, and a
 * caller-supplied `memo` shares results across every (sequential) walk of a run — without
 * both, N follow-ups on one origin cost N^depth reads of paid GitHub calls
 * (measured: 7, 127 and 1093 reads for one, two and three per PR at maxWalk 6).
 * `truncated` is set whenever the walk could not finish — an unreadable PR, an
 * unresolvable issue, or `maxWalk` exhausted — because a depth read off a broken chain is a lower bound, not a
 * measurement. A follow-up issue naming no origin PR sets `originless`
 * instead (see {@link DepthResult}).
 */
/** Results whose value depended on the walk path (a cycle cut inside them); never memoised. */
const pathDependent = new WeakSet<DepthResult>();

export async function followupDepth(
  pr: number,
  deps: DepthDeps,
  maxWalk: number,
  memo: Map<string, Promise<DepthResult>> = new Map(),
  seen: ReadonlySet<number> = new Set([pr]),
): Promise<DepthResult> {
  // Shared across every walk of a run, keyed by PR AND remaining budget: a
  // result computed with one hop left is truncated where the same origin reached
  // with more hops left is not, so a PR-only key would hand a truncated depth to
  // a chain that could have read deeper and hide a suspect one. Cost is bounded
  // by (PRs × maxWalk) walks. A result that met a cycle cut depends on the path
  // taken (`seen`), which the key does not carry, so it is never left in the memo:
  // the same origin reached along another path could continue where this one was
  // cut. Cycles in a follow-up graph are rare, so recomputing them costs little.
  // Callers must walk one PR at a time: a memoised in-flight walk is awaited by
  // any other, and two concurrent walks over a circular follow-up graph could
  // otherwise wait on each other. (A walk never awaits a PR in its own path.)
  const memoKey = `${pr}@${maxWalk}`;
  const hit = memo.get(memoKey);
  if (hit !== undefined) return hit;
  const run = (async (): Promise<DepthResult> => {
    const read = await deps.issuesOfPr(pr);
    if (read === null) {
      return { depth: 0, chain: [pr], truncated: true, originless: false };
    }
    let best: DepthResult | null = null;
    let truncated = !read.complete;
    let originless = false;
    let cut = false;
    const origins = new Set<number>();
    for (const issue of read.issues) {
      if (!issue.labels.includes(deps.followupLabel ?? DEFAULT_FOLLOWUP_LABEL))
        continue;
      const origin = originPrOf(issue);
      if (origin === null) {
        originless = true;
        continue;
      }
      // An origin already on this path is a cycle: the chain is circular, so its
      // depth is not what a straight walk would say — flag it, do not hide it.
      if (seen.has(origin)) {
        truncated = true;
        cut = true;
      } else origins.add(origin);
    }
    for (const origin of origins) {
      if (maxWalk <= 0) {
        truncated = true;
        continue;
      }
      const sub = await followupDepth(
        origin,
        deps,
        maxWalk - 1,
        memo,
        new Set([...seen, origin]),
      );
      if (best === null || sub.depth > best.depth) best = sub;
      cut = cut || pathDependent.has(sub);
      truncated = truncated || sub.truncated;
      originless = originless || sub.originless;
    }
    const out: DepthResult =
      best === null
        ? { depth: 0, chain: [pr], truncated, originless }
        : {
            depth: best.depth + 1,
            chain: [pr, ...best.chain],
            truncated: truncated || best.truncated,
            originless: originless || best.originless,
          };
    if (cut) pathDependent.add(out);
    return out;
  })();
  memo.set(memoKey, run);
  // Registered before any caller awaits `run`, so the eviction lands first.
  run.then(
    (r) => {
      if (pathDependent.has(r)) memo.delete(memoKey);
    },
    () => undefined,
  );
  return run;
}

export function followupDepthSignal(
  pr: PrFact,
  result: DepthResult,
  epics: string[],
  cfg: FleetHealthConfig,
): Signal | null {
  if (result.depth < 1) return null;
  const scope: SignalScope = { type: "pr", pr: pr.number, epics };
  const raised = result.depth >= cfg.signals.followupDepth.suspectAt;
  return {
    kind: "followup-depth",
    scope,
    severity: raised ? "elevated" : null,
    headline: `follow-up depth ${result.depth}${result.truncated ? "+" : ""}`,
    evidence: [
      `chain: ${result.chain.map((n) => `#${n}`).join(" ← ")} (each PR closes a review follow-up raised on the next)`,
      ...(result.truncated
        ? [
            `walk stopped at ${cfg.signals.followupDepth.maxWalk} hops or an unreadable PR — depth is a lower bound`,
          ]
        : []),
      ...(result.originless
        ? [
            "the chain also meets a follow-up that records no originating PR, so it ends there",
          ]
        : []),
    ],
    value: result.depth,
    fingerprint: fingerprintOf("followup-depth", scope),
    lifecycle: null,
  };
}

export function reviewCarouselSignal(
  pr: PrFact,
  epics: string[],
  cfg: FleetHealthConfig,
): Signal | null {
  const { minRounds, highRounds, minPostReviewShare } =
    cfg.signals.reviewCarousel;
  const heads = pr.rounds.length;
  if (heads < minRounds) return null;
  const share = pr.postReviewShare;
  const scope: SignalScope = { type: "pr", pr: pr.number, epics };
  const raised = share !== null && share >= minPostReviewShare;
  const answered = pr.threads.answered;
  return {
    kind: "review-carousel",
    scope,
    severity: raised ? (heads >= highRounds ? "high" : "elevated") : null,
    headline: `${heads} bot-reviewed heads, ${share === null ? "post-review churn not measured" : `${Math.round(share * 100)}% of churn after review began`}`,
    evidence: [
      `${heads} bot-reviewed heads (threshold ${minRounds}); ${pr.postReviewAdditions} of ${pr.postReviewAdditions + pr.openingAdditions} authored added lines landed after the first review — temporal, not causal`,
      `${pr.threads.total} thread(s), ${pr.threads.accepted}/${answered} answered accepted`,
    ],
    value: share,
    fingerprint: fingerprintOf("review-carousel", scope),
    lifecycle: null,
  };
}

export function deliveryShareSignal(
  d: DeliveryFact,
  cfg: FleetHealthConfig,
): Signal | null {
  if (d.totalLines === 0) return null;
  const lower = d.deliveryLines / d.totalLines;
  const upper = (d.deliveryLines + d.unclaimedSkillLines) / d.totalLines;
  const at = cfg.signals.deliverySystemShare.suspectAt;
  const scope: SignalScope = { type: "org" };
  return {
    kind: "delivery-system-share",
    scope,
    severity: at !== null && lower >= at ? "elevated" : null,
    headline: `${(lower * 100).toFixed(1)}% of merged change (lower bound; ≤ ${(upper * 100).toFixed(1)}% with .claude/skills/**)`,
    evidence: [
      `${d.deliveryLines} of ${d.totalLines} added+deleted lines across ${d.prs} merged PR(s) sit in delivery-system change areas`,
      `${d.unclaimedSkillLines} further line(s) under .claude/skills/** are claimed by no delivery-system area yet, so the share is a lower bound`,
      at === null
        ? "no threshold configured — reported only (first data point)"
        : `threshold ${at}`,
    ],
    value: lower,
    fingerprint: fingerprintOf("delivery-system-share", scope),
    lifecycle: null,
  };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * The diagnosis verdicts `fleet-coherence.md` defines — one vocabulary, not a
 * second one invented here. `established` is the only one that leaves a
 * pathology open; the other four close the suspicion and start the cooldown.
 */
export const DISPOSITIONS = [
  "false-positive",
  "early",
  "established",
  "resolved",
  "insufficient-evidence",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type LifecycleState =
  /** Crossed and never presented (or its cooldown has ended): the sensor may comment. */
  | "new"
  /** Presented on the epic; no diagnosis recorded yet. */
  | "awaiting-diagnosis"
  /** The epic's owner recorded `established`: a diagnosis, not the sensor, made it a finding. */
  | "diagnosed"
  /** Diagnosed with any closing disposition and still inside the cooldown: suppressed. */
  | "cooling-down"
  /**
   * The epic's comments could not be read, so nothing is known about what was
   * said there. Never presented (it could repeat a comment already made) and
   * never rendered as `new`.
   */
  | "unknown";

export interface Lifecycle {
  state: LifecycleState;
  presentedAt: string | null;
  diagnosedAt: string | null;
  disposition: Disposition | null;
  cooldownUntil: string | null;
}

/** The marker a sensor comment ends with; its kind is what a lifecycle keys on. */
export function suspicionMarker(kind: SignalKind): string {
  return `<!-- fleet-health: suspected kind=${kind} -->`;
}

const MARKER = /^<!--\s*fleet-health:\s*suspected\s+kind=([a-z-]+)\s*-->$/;
/**
 * A diagnosis, the way a person types it into the tracker: optional list bullet or
 * quote, any bold/italic around either word, `—`/`–`/`-`/`:` separators, and the
 * kind spelled with hyphens, spaces or run together. Kinds and dispositions are
 * compared with everything but letters stripped, so "follow-up depth" reads as
 * `followup-depth`. The disposition must be one `fleet-coherence.md` defines.
 */
// A field separator: an em/en dash or colon (any spacing, with markdown emphasis
// around it) or an ASCII hyphen WITH whitespace either side. A bare hyphen is not
// a separator — it is part of "ceremony-ratio" and "false-positive".
const SEP = String.raw`(?:[\s*_]*[—–:][\s*_]*|[\s*_]+-[\s*_]+)`;
const DIAGNOSIS_LINE = new RegExp(
  String.raw`^[\s>*_+-]*diagnosis${SEP}([a-z][a-z -]{0,60}?)${SEP}([a-z][a-z -]{0,40}?)(?=(?:${SEP}|[\s*_]+)[^\s*_—–:])`,
  "i",
);

const letters = (v: string): string => v.toLowerCase().replace(/[^a-z]/g, "");
const KIND_BY_LETTERS = new Map<string, SignalKind>(
  SIGNAL_KINDS.map((k) => [letters(k), k]),
);
const DISPOSITION_BY_LETTERS = new Map<string, Disposition>(
  DISPOSITIONS.map((d) => [letters(d), d]),
);

/** A first line is capped before matching so a hostile comment cannot make the parse slow. */
const FIRST_LINE_CAP = 300;

function firstLineOf(body: string): string {
  return (body.split("\n").find((l) => l.trim() !== "") ?? "").slice(
    0,
    FIRST_LINE_CAP,
  );
}

/** The (kind, disposition) a diagnosis first line states, or `null` if it states neither cleanly. */
function parseDiagnosis(
  line: string,
): { kind: SignalKind; disposition: Disposition } | null {
  const m = DIAGNOSIS_LINE.exec(line);
  if (m === null) return null;
  const kind = KIND_BY_LETTERS.get(letters(m[1] as string));
  // The disposition group is lazy up to the next separator or whitespace, so a
  // reason that follows without a separator ("... resolved fixed it") is still
  // read by its head. It must EQUAL a declared disposition: a prefix match would
  // read "resolvedly" as `resolved` and let a non-verdict silence the signal.
  const disposition = DISPOSITION_BY_LETTERS.get(letters(m[2] as string));
  return kind === undefined || disposition === undefined
    ? null
    : { kind, disposition };
}

/** The marker counts only as the comment's LAST non-empty line, never when merely quoted. */
function markerKindOf(body: string): string | null {
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  const m = MARKER.exec((lines[lines.length - 1] ?? "").trim());
  return m === null ? null : (m[1] as string);
}

/**
 * Comments that BEGIN with the word "diagnosis" but that the parser above does
 * not read. Broader than the recognizer on purpose: an answer that cannot be
 * parsed is reported, not silently dropped, because to the owner who wrote it
 * the signal is answered and to the sensor it is still waiting. Only a line
 * that STARTS with the word counts — a reply that merely mentions one ("thanks,
 * diagnosis after standup") is conversation, and flagging it would leave a
 * report needing a person to edit a comment before it could ever be complete.
 */
export function unparsedDiagnoses(
  comments: ReadonlyArray<CommentFact>,
): CommentFact[] {
  return comments.filter((c) => {
    if (!c.trusted) return false;
    const first = firstLineOf(c.body);
    return (
      /^[\s>*_+-]*diagnosis\b/i.test(first) &&
      parseDiagnosis(first) === null &&
      markerKindOf(c.body) === null
    );
  });
}

/** The signal-kind head of a diagnosis line, even when its disposition does not parse. */
const DIAGNOSIS_KIND_HEAD = new RegExp(
  String.raw`^[\s>*_+-]*diagnosis${SEP}([a-z][a-z -]{0,60}?)(?:${SEP}|$)`,
  "i",
);

/**
 * Whether a malformed diagnosis on the epic still leaves `kind` unanswerable. A
 * malformed comment concerns one signal when its kind head names one, so it
 * cannot silence a different signal; and it stops mattering once a later
 * presentation or parsed diagnosis for `kind` exists — the same latest-wins rule
 * `deriveLifecycle` applies to well-formed comments. A head that names no known
 * kind could concern any signal and is not scoped.
 */
function unparsedBlocks(
  kind: SignalKind,
  comments: ReadonlyArray<CommentFact>,
  latestEventMs: number,
): boolean {
  return unparsedDiagnoses(comments).some((c) => {
    const head = DIAGNOSIS_KIND_HEAD.exec(firstLineOf(c.body));
    const named =
      head === null
        ? undefined
        : KIND_BY_LETTERS.get(letters(head[1] as string));
    if (named !== undefined && named !== kind) return false;
    return Date.parse(c.createdAt) > latestEventMs;
  });
}

/**
 * Where one signal stands, read from the comments on its epic. The tracker is the
 * store — durable, cross-worktree, visible to a human — so no local state file
 * can disagree with what the epic's owner sees.
 *
 * The latest of {sensor presentation, diagnosis} for this `kind` decides. A
 * diagnosis with no presentation before it still counts: an owner who
 * diagnosed proactively has said something the sensor must not talk over.
 */
export function deriveLifecycle(
  kind: SignalKind,
  comments: ReadonlyArray<CommentFact>,
  nowMs: number,
  cooldownDays: number,
): Lifecycle {
  type Event = { at: string; kind: "presented" | Disposition };
  const events: Event[] = [];
  for (const c of comments) {
    if (!c.trusted) continue;
    if (markerKindOf(c.body) === kind) {
      events.push({ at: c.createdAt, kind: "presented" });
      continue;
    }
    const d = parseDiagnosis(firstLineOf(c.body));
    if (d !== null && d.kind === kind) {
      events.push({ at: c.createdAt, kind: d.disposition });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestEvent = events[events.length - 1];
  if (
    unparsedBlocks(
      kind,
      comments,
      latestEvent === undefined ? -Infinity : Date.parse(latestEvent.at),
    )
  ) {
    return {
      state: "unknown",
      presentedAt: null,
      diagnosedAt: null,
      disposition: null,
      cooldownUntil: null,
    };
  }
  const presentedAt =
    [...events].reverse().find((e) => e.kind === "presented")?.at ?? null;
  const last = events[events.length - 1];
  if (last === undefined) {
    return {
      state: "new",
      presentedAt: null,
      diagnosedAt: null,
      disposition: null,
      cooldownUntil: null,
    };
  }
  if (last.kind === "presented") {
    return {
      state: "awaiting-diagnosis",
      presentedAt,
      diagnosedAt: null,
      disposition: null,
      cooldownUntil: null,
    };
  }
  if (last.kind === "established") {
    return {
      state: "diagnosed",
      presentedAt,
      diagnosedAt: last.at,
      disposition: "established",
      cooldownUntil: null,
    };
  }
  const cooldownUntil = new Date(
    Date.parse(last.at) + cooldownDays * DAY_MS,
  ).toISOString();
  return {
    state: nowMs < Date.parse(cooldownUntil) ? "cooling-down" : "new",
    presentedAt,
    diagnosedAt: last.at,
    disposition: last.kind,
    cooldownUntil,
  };
}

/**
 * The epics a signal is presented on — its durable address. Only the
 * epic-lifecycle kinds have one; the rest are advisory (a PR's drive brief, the
 * dashboard) and are never commented anywhere.
 */
export function lifecycleTargets(s: Pick<Signal, "kind" | "scope">): string[] {
  if (!EPIC_LIFECYCLE_KINDS.includes(s.kind)) return [];
  if (s.scope.type === "epic") return [s.scope.epic];
  if (s.scope.type === "pr") return s.scope.epics;
  return [];
}

// ── The report ─────────────────────────────────────────────────────────────

export interface FleetHealthReport {
  version: 1;
  generatedAt: string;
  window: { since: string; until: string; days: number };
  signals: Signal[];
  epics: EpicUnits[];
  /**
   * One slim row per PR that had any bot-reviewed head, so a threshold can be
   * re-graded offline from a recorded run without paying to sample again.
   */
  prs: PrSummary[];
  counts: { prs: number; epicsWithActivity: number };
  /**
   * DEGRADATIONS: something that should have been read was not (an unsampled
   * PR, an unavailable catalog). Non-empty ⇒ the report is partial.
   */
  gaps: string[];
  /** Standing limits on how to read the figures — true of every run. */
  caveats: string[];
}

export interface PrSummary {
  number: number;
  state: PrFact["state"];
  epics: string[];
  heads: number;
  postReviewShare: number | null;
  threads: PrFact["threads"];
  followupDepth: number | null;
}

/** Current started epics, read independently of the rolling ceremony window. */

export function stuckEpicSignal(
  fact: EpicActivityFact,
  nowMs: number,
  cfg: FleetHealthConfig,
): Signal | null {
  if (!fact.children.length) return null;
  const last = Math.max(
    Date.parse(fact.startedAt),
    ...fact.children.map((c) => Date.parse(c.updatedAt)),
  );
  if (!Number.isFinite(last))
    throw new Error(`Unreadable child activity for ${fact.epic}`);
  // Collection freezes nowMs before the network read; a legitimate child edit
  // during that read is recent activity, not a malformed population.
  if (last > nowMs) return null;
  const days = (nowMs - last) / DAY_MS;
  if (days < cfg.signals.stuckEpic.days) return null;
  const scope: SignalScope = { type: "epic", epic: fact.epic };
  return {
    kind: "stuck-epic",
    scope,
    severity: "elevated",
    headline: `children have not moved for ${Math.floor(days)} days`,
    evidence: [
      `last child activity or epic start: ${new Date(last).toISOString()}; threshold ${cfg.signals.stuckEpic.days} days`,
      "Child updatedAt includes prose edits; this conservative activity proxy is a suspicion, not a diagnosis.",
    ],
    value: days,
    fingerprint: fingerprintOf("stuck-epic", scope),
    lifecycle: null,
  };
}

// ── The epic census ────────────────────────────────────────────────────────
//
// Signals about the shape of an open epic, read from the same started-epic
// census as `stuck-epic`. They are read-only: they raise nothing a person must
// answer and post nothing. They feed the closure step, and every one that
// points at closing an epic repeats that closing needs an accepting verdict.

const isClosed = (stateType: string): boolean =>
  (CLOSED_STATE_TYPES as readonly string[]).includes(stateType);

/** Abandoned work is not delivery: it leaves the denominator, as in the closure step. */
const isAbandoned = (stateType: string): boolean =>
  stateType === "canceled" || stateType === "duplicate";

const ACCEPTANCE_REMINDER =
  "Closing an epic requires an accepting acceptance verdict (or a recorded waiver): every child closed is not itself the authorization.";

/** Every child closed, the epic still open. */
export function finishedButOpenSignal(fact: EpicActivityFact): Signal | null {
  if (!fact.children.length) return null;
  if (!fact.children.every((c) => isClosed(c.stateType))) return null;
  const scope: SignalScope = { type: "epic", epic: fact.epic };
  const abandoned = fact.children.filter((c) => isAbandoned(c.stateType));
  return {
    kind: "finished-but-open",
    scope,
    severity: "elevated",
    headline: `all ${fact.children.length} children are closed, but the epic is still open`,
    evidence: [
      abandoned.length === 0
        ? `${fact.children.length} of ${fact.children.length} children completed`
        : `${fact.children.length - abandoned.length} children completed, ${abandoned.length} abandoned (canceled or duplicate)`,
      ACCEPTANCE_REMINDER,
    ],
    value: fact.children.length,
    fingerprint: fingerprintOf("finished-but-open", scope),
    lifecycle: null,
  };
}

/** Nearly done: at least the configured share delivered, only a few children still open. */
export function tailBlockedSignal(
  fact: EpicActivityFact,
  cfg: FleetHealthConfig,
): Signal | null {
  const counted = fact.children.filter((c) => !isAbandoned(c.stateType));
  const open = counted.filter((c) => !isClosed(c.stateType));
  if (counted.length === 0 || open.length === 0) return null;
  const share = (counted.length - open.length) / counted.length;
  const { minDoneShare, maxOpen } = cfg.signals.tailBlocked;
  if (share < minDoneShare || open.length > maxOpen) return null;
  const scope: SignalScope = { type: "epic", epic: fact.epic };
  return {
    kind: "tail-blocked",
    scope,
    severity: "elevated",
    headline: `${Math.round(share * 100)}% done; ${open.length} child${open.length === 1 ? "" : "ren"} still open: ${open.map((c) => c.issue).join(", ")}`,
    evidence: [
      `${counted.length - open.length} of ${counted.length} children delivered (abandoned children excluded); thresholds: at least ${Math.round(minDoneShare * 100)}% done, at most ${maxOpen} open`,
      "A tail child may be finished, handed off to its own owner, or dropped with a reason. " +
        ACCEPTANCE_REMINDER,
    ],
    value: share,
    fingerprint: fingerprintOf("tail-blocked", scope),
    lifecycle: null,
  };
}

/**
 * Nothing ties the epic to a place or a person: no children, no project, no
 * assignee and no repository label. Not measured (null) when the consumer
 * names no repository labels, since "no repository" cannot then be asserted.
 */
export function orphanRiskSignal(
  fact: EpicActivityFact,
  cfg: FleetHealthConfig,
): Signal | null {
  if (cfg.labels.repositories.length === 0) return null;
  if (
    fact.children.length > 0 ||
    fact.project !== null ||
    fact.assignee !== null ||
    fact.labels.some((l) => cfg.labels.repositories.includes(l))
  )
    return null;
  const scope: SignalScope = { type: "epic", epic: fact.epic };
  return {
    kind: "orphan-risk",
    scope,
    severity: "elevated",
    headline: "no children, no project, no owner and no repository",
    evidence: [
      `repository labels checked: ${cfg.labels.repositories.join(", ")}`,
      "An epic like this has nobody who would notice it going stale: give it an owner, a project or a repository, or close it. " +
        ACCEPTANCE_REMINDER,
    ],
    value: 0,
    fingerprint: fingerprintOf("orphan-risk", scope),
    lifecycle: null,
  };
}

/** Standing limits on reading the census, and what it could not measure. */
export function censusCaveats(cfg: FleetHealthConfig): string[] {
  return [
    "The epic census (finished-but-open, tail-blocked, orphan-risk) is CURRENT state of started epics only, read-only, and never commented on an epic; a finished-but-open epic is not also reported as stuck. Closing an epic requires an accepting acceptance verdict.",
    ...(cfg.labels.repositories.length === 0
      ? [
          'Orphan-risk is NOT MEASURED: no repository labels are configured (labels.repositories in the fleet-health config, or review.taxonomy.repos), so "no repository" cannot be asserted of any epic.',
        ]
      : []),
  ];
}

/** Every epic-scoped signal one started epic raises. */
export function epicSignals(
  fact: EpicActivityFact,
  nowMs: number,
  cfg: FleetHealthConfig,
): Signal[] {
  // A finished epic's idle children are not a stall; finished-but-open says
  // what is true of it.
  const finished = finishedButOpenSignal(fact);
  return [
    finished ?? stuckEpicSignal(fact, nowMs, cfg),
    tailBlockedSignal(fact, cfg),
    orphanRiskSignal(fact, cfg),
  ].filter((s): s is Signal => s !== null);
}

export interface ReportInput extends UnitsInput {
  epicActivity?: ReadonlyArray<EpicActivityFact>;
  nowMs: number;
  depthByPr: ReadonlyMap<number, DepthResult>;
  /** Comments per epic (only epics that raised something need an entry). */
  epicComments: ReadonlyMap<string, ReadonlyArray<CommentFact>>;
  /** Epics whose comments were needed and could not be read: their lifecycle is `unknown`. */
  unknownEpics?: ReadonlySet<string>;
  delivery: DeliveryFact | null;
  gaps: ReadonlyArray<string>;
  caveats: ReadonlyArray<string>;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  maximum: 3,
  high: 2,
  elevated: 1,
};

/** Lower is more active; a multi-epic signal takes the lowest of its epics' states. */
export const LIFECYCLE_ACTIVITY: Record<LifecycleState, number> = {
  new: 0,
  "awaiting-diagnosis": 1,
  diagnosed: 2,
  unknown: 3,
  "cooling-down": 4,
};

export function buildReport(input: ReportInput): FleetHealthReport {
  const { cfg } = input;
  const units = computeEpicUnits(input);
  const signals: Signal[] = [];
  for (const fact of input.epicActivity ?? [])
    signals.push(...epicSignals(fact, input.nowMs, cfg));

  for (const u of units.values()) {
    const s = ceremonyRatioSignal(u, cfg);
    if (s !== null) signals.push(s);
  }
  for (const pr of input.prs) {
    const epics = epicsOfPr(pr, input.issues, cfg.labels.epic);
    const depth = input.depthByPr.get(pr.number);
    if (depth !== undefined) {
      const s = followupDepthSignal(pr, depth, epics, cfg);
      if (s !== null) signals.push(s);
    }
    const carousel = reviewCarouselSignal(pr, epics, cfg);
    if (carousel !== null) signals.push(carousel);
  }
  if (input.delivery !== null) {
    const s = deliveryShareSignal(input.delivery, cfg);
    if (s !== null) signals.push(s);
  }

  // Lifecycle: an epic-scoped signal reads its own epic's comments. A PR-scoped
  // depth signal inherits the lifecycle of the epic(s) it is attributed to, so a
  // depth suspicion on an epic's PR is presented on that epic — and stays quiet
  // once the epic's owner has diagnosed it. A signal with no epic has no
  // durable address, so it is advisory only (the drive brief) and has none.
  for (const s of signals) {
    if (s.severity === null) continue;
    const lifecycles = lifecycleTargets(s).map(
      (e): Lifecycle =>
        input.unknownEpics?.has(e) === true
          ? {
              state: "unknown",
              presentedAt: null,
              diagnosedAt: null,
              disposition: null,
              cooldownUntil: null,
            }
          : deriveLifecycle(
              s.kind,
              input.epicComments.get(e) ?? [],
              input.nowMs,
              cfg.lifecycle.cooldownDays,
            ),
    );
    // The scalar must not read quiet while ANY of its epics is still live:
    // `activeSignals` and `prWarnings` suppress only on `cooling-down`, so the
    // most active state among its epics wins and `cooling-down` only when every
    // epic is cooling.
    s.lifecycle =
      [...lifecycles].sort(
        (a, b) => LIFECYCLE_ACTIVITY[a.state] - LIFECYCLE_ACTIVITY[b.state],
      )[0] ?? null;
  }

  signals.sort(
    (a, b) =>
      (b.severity === null ? 0 : SEVERITY_RANK[b.severity]) -
        (a.severity === null ? 0 : SEVERITY_RANK[a.severity]) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );

  const gaps = [...input.gaps];

  return {
    version: 1,
    generatedAt: new Date(input.nowMs).toISOString(),
    window: {
      since: new Date(input.window.sinceMs).toISOString(),
      until: new Date(input.window.untilMs).toISOString(),
      days: Math.round((input.window.untilMs - input.window.sinceMs) / DAY_MS),
    },
    signals,
    epics: [...units.values()].sort((a, b) => a.epic.localeCompare(b.epic)),
    prs: input.prs
      .filter((p) => p.rounds.length > 0 || input.depthByPr.has(p.number))
      .map((p) => ({
        number: p.number,
        state: p.state,
        epics: epicsOfPr(p, input.issues, input.cfg.labels.epic),
        heads: p.rounds.length,
        postReviewShare: p.postReviewShare,
        threads: p.threads,
        followupDepth: input.depthByPr.get(p.number)?.depth ?? null,
      }))
      .sort((a, b) => a.number - b.number),
    counts: { prs: input.prs.length, epicsWithActivity: units.size },
    gaps,
    caveats: [...input.caveats],
  };
}

/** One comment the sensor may post: everything of one kind that raised on one epic. */
export interface Presentation {
  kind: SignalKind;
  epic: string;
  signals: Signal[];
}

/**
 * Every comment the sensor may post on an epic right now, grouped by (kind,
 * epic): the signals raised something, and THAT epic's own lifecycle for that
 * kind says `new`.
 *
 * Grouped, not one per signal. A single epic can carry a dozen PRs at follow-up
 * depth two in one window (measured: eight on), and a comment per PR
 * would make the sensor the loudest source of ceremony on the very epic it is
 * asking someone to diagnose. The lifecycle is keyed the same way — a diagnosis
 * answers "follow-up depth on this epic", not one PR — so grouping is the shape
 * that keeps the two consistent. Per epic also means a depth suspicion
 * attributed to two epics is quiet on the one that already diagnosed it and
 * presentable on the other.
 */
export function presentable(
  report: FleetHealthReport,
  epicComments: ReadonlyMap<string, ReadonlyArray<CommentFact>>,
  nowMs: number,
  cooldownDays: number,
  unknownEpics: ReadonlySet<string> = new Set(),
): Presentation[] {
  const groups = new Map<string, Presentation>();
  for (const signal of report.signals) {
    if (signal.severity === null) continue;
    for (const epic of lifecycleTargets(signal)) {
      // An epic whose comments were not read is never presented on: it may
      // already carry this very comment.
      if (unknownEpics.has(epic)) continue;
      const l = deriveLifecycle(
        signal.kind,
        epicComments.get(epic) ?? [],
        nowMs,
        cooldownDays,
      );
      if (l.state !== "new") continue;
      const key = `${signal.kind}:${epic}`;
      const g = groups.get(key) ?? { kind: signal.kind, epic, signals: [] };
      g.signals.push(signal);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

/** Signals that raised something and are not in a cooldown: what a human should look at. */
export function activeSignals(report: FleetHealthReport): Signal[] {
  return report.signals.filter(
    (s) => s.severity !== null && s.lifecycle?.state !== "cooling-down",
  );
}

/**
 * The advisory lines for one PR, for the drive's round brief (beside
 * `reflectDue`). Only PR-scoped signals that raised something — an epic's
 * ratio is for whoever holds the epic, not for a pass working one PR.
 */
export function prWarnings(
  signals: ReadonlyArray<
    Pick<Signal, "kind" | "scope" | "severity" | "headline"> & {
      /** The signal's lifecycle state on its epic, when it has one. */
      state?: string | null;
    }
  >,
  pr: number,
): string[] {
  return signals
    .filter(
      (s) =>
        s.severity !== null &&
        s.scope.type === "pr" &&
        s.scope.pr === pr &&
        // A diagnosis that closed the suspicion silences it for the cooldown —
        // the comment the sensor posts promises exactly that, and a drive brief
        // that kept warning would contradict it on every round.
        s.state !== "cooling-down",
    )
    .map((s) => `${s.kind}: ${s.headline}`);
}

// ── Rendering ──────────────────────────────────────────────────────────────

function day(iso: string): string {
  return iso.slice(0, 10);
}

function signalLines(s: Signal): string[] {
  const where =
    s.scope.type === "epic"
      ? s.scope.epic
      : s.scope.type === "pr"
        ? `PR #${s.scope.pr}${s.scope.epics.length > 0 ? ` (${s.scope.epics.join(", ")})` : ""}`
        : "organization";
  const state =
    s.lifecycle === null
      ? ""
      : ` [${s.lifecycle.state}${s.lifecycle.disposition !== null ? `: ${s.lifecycle.disposition}` : ""}]`;
  const severity = (s.severity ?? "").toUpperCase().padEnd(8);
  return [
    `  ${severity} ${s.kind} — ${where}: ${s.headline}${state}`,
    ...s.evidence.map((e) => `             ${e}`),
  ];
}

export function renderReport(r: FleetHealthReport): string {
  const lines: string[] = [];
  lines.push(
    `Fleet health — ${day(r.window.since)} → ${day(r.window.until)} (${r.window.days} days, exclusive end)`,
    `${r.counts.prs} PR(s) read, ${r.counts.epicsWithActivity} epic(s) with activity`,
    "",
  );
  const isCensus = (s: Signal): boolean => EPIC_CENSUS_KINDS.includes(s.kind);
  const raised = r.signals.filter((s) => s.severity !== null && !isCensus(s));
  const census = r.signals.filter(isCensus);
  const reported = r.signals.filter(
    (s) => s.severity === null && s.scope.type === "org",
  );
  lines.push(
    `SUSPICIONS (${raised.length}) — counts raise a suspicion; only a diagnosis on the epic confirms one`,
  );
  if (raised.length === 0) lines.push("  none");
  for (const s of raised) lines.push(...signalLines(s));
  if (census.length > 0) {
    lines.push(
      "",
      `EPIC CENSUS (${census.length}) — the epic's current shape, read-only; no diagnosis confirms or silences it`,
    );
    for (const s of census) lines.push(...signalLines(s));
  }
  if (reported.length > 0) {
    lines.push("", "REPORTED (no threshold)");
    for (const s of reported) {
      lines.push(`  ${s.kind}: ${s.headline}`);
      for (const e of s.evidence) lines.push(`             ${e}`);
    }
  }
  if (r.gaps.length > 0) {
    lines.push("", "PARTIAL — something that should have been read was not");
    for (const g of r.gaps) lines.push(`  - ${g}`);
  }
  if (r.caveats.length > 0) {
    lines.push("", "READ THE FIGURES ABOVE AS BOUNDED BY");
    for (const c of r.caveats) lines.push(`  - ${c}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Signals listed in a comment before "and N more"; the report holds them all. */
const COMMENT_SIGNAL_CAP = 5;

/** The comment the sensor posts on an epic for a `new` suspicion. Ends with the marker the lifecycle keys on. */
export function suspicionComment(
  p: Presentation,
  r: FleetHealthReport,
): string {
  const ranked = [...p.signals].sort(
    (a, b) =>
      (b.severity === null ? 0 : SEVERITY_RANK[b.severity]) -
        (a.severity === null ? 0 : SEVERITY_RANK[a.severity]) ||
      (b.value ?? 0) - (a.value ?? 0),
  );
  const shown = ranked.slice(0, COMMENT_SIGNAL_CAP);
  const top = shown[0];
  const lines = [
    `**fleet-health** — ${p.kind} — suspicion${top?.severity ? ` (${top.severity})` : ""}, window ${day(r.window.since)} → ${day(r.window.until)}`,
    "",
  ];
  for (const s of shown) {
    const where = s.scope.type === "pr" ? `PR #${s.scope.pr}: ` : "";
    lines.push(
      `**${where}${s.headline}**`,
      ...s.evidence.map((e) => `- ${e}`),
      "",
    );
  }
  if (ranked.length > shown.length) {
    lines.push(
      `…and ${ranked.length - shown.length} more like it on this epic in the window (the full list is \`fleet-health.ts --json\`).`,
      "",
    );
  }
  lines.push(
    "This is a count crossing a threshold, not a finding. If you hold this epic's context, record what it is with a comment whose FIRST LINE is:",
    "",
    `\`**diagnosis** — ${p.kind} — <${DISPOSITIONS.join("|")}> — <one-line reason>\``,
    "",
    "`established` = a real pathology, being handled (stays open until a later `resolved`); `resolved` = it was, and is fixed; `false-positive` = not a pathology (e.g. a terminal-week spike); `early` = real but too early to act on; `insufficient-evidence` = cannot tell. Every disposition except `established` silences this signal on this epic for the cooldown period.",
    "",
    suspicionMarker(p.kind),
  );
  return lines.join("\n");
}
