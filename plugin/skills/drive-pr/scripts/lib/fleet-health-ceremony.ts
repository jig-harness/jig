/** Per-epic ceremony and progress accounting, bounded to the report window. */
import type { FleetHealthConfig } from "./fleet-health-config.ts";
import type {
  IssueFact,
  WindowSpec,
} from "../../../do-item/scripts/lib/tracker/port.ts";
/** The default epic label, when a caller names none. */
export const DEFAULT_EPIC_LABEL = "epic";

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
  /** Re-arm event times from the forge ledger; absent when not read. */
  driveRearms?: string[];
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
    driveRearms?: Array<{ pr: number; count: number }>;
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
  const { cfg } = input;
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
          driveRearms: [],
          followupsMinted: [],
          sdlcIssuesOpened: [],
          weighted: 0,
        },
      };
      byEpic.set(epic, u);
    }
    return u;
  };

  collectPrUnits(input, unitsFor);
  collectIssueUnits(input, unitsFor);
  for (const epic of input.acceptedEpics)
    unitsFor(epic).progress.accepted = true;

  weightUnits(byEpic, cfg);
  return byEpic;
}

/** Attribute each pull request's product work, review rounds and re-arms. */
function collectPrUnits(
  input: UnitsInput,
  unitsFor: (epic: string) => EpicUnits,
): void {
  const { cfg, window: w } = input;
  const epicLabel = cfg.labels.epic;
  for (const pr of input.prs) {
    const merged =
      pr.state === "MERGED" &&
      inWindow(pr.mergedAt, w) &&
      pr.productPr === true;
    const rearms = (pr.driveRearms ?? []).filter((at) =>
      inWindow(at, w),
    ).length;
    const beyond = pr.rounds.filter(
      (at, i) => i + 1 > cfg.ceremony.freeRounds && inWindow(at, w),
    ).length;
    if (!merged && rearms === 0 && beyond === 0) continue;
    for (const epic of epicsOfPr(pr, input.issues, epicLabel))
      addPrActivity(unitsFor(epic), pr.number, { merged, rearms, beyond });
  }
}

function addPrActivity(
  u: EpicUnits,
  pr: number,
  activity: { merged: boolean; rearms: number; beyond: number },
): void {
  if (activity.merged) u.progress.mergedProductPrs.push(pr);
  if (activity.rearms > 0)
    u.ceremony.driveRearms?.push({ pr, count: activity.rearms });
  if (activity.beyond > 0)
    u.ceremony.roundsBeyondFree.push({ pr, rounds: activity.beyond });
}

/** Charge each tracker issue once and credit completed acceptance work. */
function collectIssueUnits(
  input: UnitsInput,
  unitsFor: (epic: string) => EpicUnits,
): void {
  const { cfg, window: w } = input;
  const epicLabel = cfg.labels.epic;
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
  collectCompletedUnits(input, unitsFor);
}

function collectCompletedUnits(
  input: UnitsInput,
  unitsFor: (epic: string) => EpicUnits,
): void {
  const { cfg, window: w } = input;
  const epicLabel = cfg.labels.epic;
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
}

/** Apply consumer weights after all activity has been attributed. */
function weightUnits(
  byEpic: Map<string, EpicUnits>,
  cfg: FleetHealthConfig,
): void {
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
      u.ceremony.sdlcIssuesOpened.length * cw.weights.sdlcIssuesOpened +
      (u.ceremony.driveRearms ?? []).reduce((n, r) => n + r.count, 0) *
        (cw.weights.driveRearms ?? 1);
  }
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
    n += (pr.driveRearms ?? []).filter((at) => inWindow(at, w)).length;
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
