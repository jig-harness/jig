/**
 * The tracker half of the fractal-SDLC scoreboard.
 *
 * Reads through do-item's tracker port (the adapter the consumer names in
 * `issue_tracker.adapter`); what it reads is the consumer's fleet-health
 * configuration (`lib/fleet-health-config.ts`):
 *
 *  - the BASELINE COHORT — issues carrying the follow-up label
 *    (`labels.followup`) created in the window — the population the recorded
 *    baselines measure;
 *  - the LEDGER — the follow-up label ∪ the debt project (`ledger.label`,
 *    `ledger.project`) — printed as context. Its population is not the
 *    cohort's, so comparing the two would compare different sets;
 *  - the issues carrying the epic label (`labels.epic`), for open and
 *    completed counts.
 */

import { connectTracker } from "./fleet-health-sources.ts";
import { type FleetHealthConfig, loadConfig } from "./fleet-health-config.ts";
import {
  cohortStats,
  epicStats,
  type LedgerContext,
  type LinearSide,
} from "./fractal.ts";
import type {
  LedgerIssue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";

export interface LinearWindow {
  sinceMs: number;
  untilMs: number;
  nowMs: number;
}

const DAY_MS = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Whole days from `iso` to `nowMs`, floored: an issue 6.9 days old is in its 7th day. */
function daysSince(iso: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(iso)) / DAY_MS);
}

/**
 * The ledger's figures as the scoreboard prints them, over the `windowDays`
 * ending at `nowMs`. A closed issue's close instant is its completion or
 * cancellation; a closed issue carrying neither (a duplicate) has no instant
 * and counts in no window. Shares are fractions.
 */
export function ledgerContextOf(
  issues: ReadonlyArray<LedgerIssue>,
  closedStateTypes: ReadonlyArray<string>,
  windowDays: number,
  nowMs: number,
): LedgerContext {
  const isOpen = (i: LedgerIssue) => !closedStateTypes.includes(i.stateType);
  const open = issues.filter(isOpen);
  const since = nowMs - windowDays * DAY_MS;
  const inWindow = (iso: string | null): boolean => {
    if (iso === null) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t <= nowMs;
  };
  const minted = issues.filter((i) => inWindow(i.createdAt)).length;
  const closedInWindow = issues.filter(
    (i) => !isOpen(i) && inWindow(i.completedAt ?? i.canceledAt),
  ).length;
  const ages = open
    .map((i) => daysSince(i.createdAt, nowMs))
    .sort((a, b) => a - b);
  const mid = Math.floor(ages.length / 2);
  const median =
    ages.length === 0
      ? null
      : ages.length % 2 === 1
        ? (ages[mid] as number)
        : round2(((ages[mid - 1] as number) + (ages[mid] as number)) / 2);
  const priorityless = open.filter((i) => i.priority === 0).length;
  return {
    total: issues.length,
    open: open.length,
    closed: issues.length - open.length,
    windowDays,
    minted,
    closedInWindow,
    mintedPerDay: round2(minted / windowDays),
    closedPerDay: round2(closedInWindow / windowDays),
    // A zero denominator is unmeasurable, not infinite accrual.
    mintToCloseRatio:
      closedInWindow === 0 ? null : round2(minted / closedInWindow),
    medianOpenAgeDays: median,
    oldestOpenAgeDays: ages.length === 0 ? null : (ages.at(-1) as number),
    priorityless,
    prioritylessShare:
      open.length === 0 ? 0 : round2((100 * priorityless) / open.length) / 100,
    truncated: issues
      .filter((i) => i.truncated.length > 0)
      .map((i) => `${i.identifier}:${i.truncated.join(",")}`),
  };
}

/**
 * Fetch and compute the tracker side. Throws with a reason on anything it
 * cannot establish — no configuration, no credential, a tracker error — and
 * the caller reports the side as not measured.
 */
export async function fetchLinearSide(
  win: LinearWindow,
  note: (msg: string) => void = () => undefined,
  cfg: FleetHealthConfig = loadConfig(),
  tracker: Tracker = connectTracker(cfg),
): Promise<LinearSide> {
  const cohortLabel = cfg.labels.followup;
  if (cohortLabel === null)
    throw new Error(
      "no follow-up label is configured (labels.followup in the fleet-health config, or review.taxonomy.provenance_label), so the cohort cannot be read",
    );
  const ledgerLabel = cfg.ledger.label ?? cohortLabel;
  // The cohort is read out of the ledger, so the ledger must be the cohort's
  // label: another label would silently shrink the cohort.
  if (ledgerLabel !== cohortLabel)
    throw new Error(
      `the ledger label is '${ledgerLabel}', but the baseline cohort is '${cohortLabel}'; refusing to compare different populations`,
    );
  const { closedStateTypes } = cfg.ledger;
  const issues = await tracker.ledger(
    {
      label: ledgerLabel,
      ...(cfg.ledger.project === null ? {} : { project: cfg.ledger.project }),
    },
    (n) => note(`tracker: fetched ${n} ledger issues…`),
  );
  // An empty ledger is a wrong name, not a debt-free repository, and a
  // scoreboard built on it would read as "nothing minted".
  if (issues.length === 0) {
    throw new Error(
      `the ledger is empty — no issue carries label '${ledgerLabel}'${cfg.ledger.project === null ? "" : ` or belongs to project '${cfg.ledger.project}'`}`,
    );
  }

  const cohort = cohortStats(issues, {
    label: cohortLabel,
    sinceMs: win.sinceMs,
    untilMs: win.untilMs,
    nowMs: win.nowMs,
    closedStateTypes,
  });
  // A non-empty ledger with an empty cohort is a window that predates the
  // label (or a wrong `--until`), not a month in which nothing was minted:
  // reported as 0 mints and 0 open it would read as "improved" on every row.
  if (cohort.minted === 0) {
    throw new Error(
      `no '${cohortLabel}' issue was created in ${cohort.since} → ${cohort.until}; refusing to report 0 mints as an improvement`,
    );
  }

  const windowDays = Math.max(
    1,
    Math.round((win.untilMs - win.sinceMs) / DAY_MS),
  );
  const ledger = ledgerContextOf(
    issues,
    closedStateTypes,
    windowDays,
    win.nowMs,
  );

  note("tracker: fetching epics…");
  const epicLabel = cfg.labels.epic;
  const epicNodes = await tracker.labelledIssues(epicLabel);
  // A renamed label returns a valid, silently empty page, which would report
  // 0 open epics as an improvement.
  if (epicNodes.length === 0) {
    throw new Error(
      `no issue carries the '${epicLabel}' label in the tracker — far more likely a renamed label than zero epics`,
    );
  }
  const epics = epicStats(
    epicNodes,
    closedStateTypes,
    win.sinceMs,
    win.untilMs,
  );

  return { cohort, epics, ledger };
}
