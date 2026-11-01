/**
 * The plan: what the records want, minus what the runtime reports running.
 * Every item or pull request gets at most one action, naming the record
 * that wants it and its evidence. A target the tick cannot place (a record
 * it could not read, a runtime answer it cannot trust, a workspace whose
 * terminals the runtime cannot read) is reported and never planned. The
 * pickups' part is `plan-pickups.ts`.
 */
import { driveHold, factsOf } from "./actions/drive-hold.ts";
import { holding, liveAgents } from "./holding.ts";
import type { ReadRecord } from "./launches.ts";
import { planPickups } from "./plan-pickups.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import type {
  Action,
  ClaimedItem,
  DispatchSection,
  DrivenPr,
  LedgerClass,
  MergedPr,
  RepoReport,
  Running,
  Stage,
  WantedItem,
} from "./types.ts";

export interface PlanInput {
  section: DispatchSection;
  pickups: WantedItem[];
  /** The items the factory identity claimed; `null` when they could not be read. */
  claimed: ClaimedItem[] | null;
  drives: DrivenPr[];
  merged: MergedPr[];
  sessions: SessionsReport;
  /** This machine's launch records for the repository. */
  launches: ReadRecord[];
  /** Since when each claimed item has been idle (the idle clock). */
  idleSince: ReadonlyMap<string, number>;
  nowMs: number;
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet"> & {
  /** The claimed items idle this tick, for the idle clock. */
  idleNow: string[];
};

/** The ledger classes that need nothing from the tick but a line in the report. */
const QUIET: ReadonlySet<LedgerClass> = new Set([
  "driven",
  "silent",
  "done",
  "stopped-by-person",
  "refused",
]);

/** The ledger classes a person must settle: notified, never re-armed. */
const NOTIFY: ReadonlySet<LedgerClass> = new Set([
  "stopped-unknown",
  "parked",
  "needs-person",
]);

export function planTick(input: PlanInput): Plan {
  const { sessions } = input;
  const plan: Plan = planPickups(input);

  /** One wanted stage for one target, minus what is running. */
  function want(action: Action, joined: (w: Workspace) => boolean): void {
    const held = holding(sessions, joined);
    if (held.kind === "unknown") {
      plan.unplaced.push({
        target: action.target,
        record: "runtime",
        reason: held.reason,
      });
      return;
    }
    if (held.kind === "running") {
      plan.running.push({
        target: action.target,
        stage: action.stage,
        reason: `a session is running for it: ${liveAgents(held.workspaces)}`,
        evidence: { workspaces: held.workspaces.map((w) => w.path).join(", ") },
      } satisfies Running);
      return;
    }
    plan.actions.push(
      held.evidence === null
        ? action
        : {
            ...action,
            evidence: { ...action.evidence, finishedSessions: held.evidence },
          },
    );
  }

  // A pull request in both populations merged between the two reads: the
  // merged state wins, so it gets its follow-up and no re-arm.
  const mergedNumbers = new Set(input.merged.map((m) => m.number));
  for (const pr of input.drives.filter((d) => !mergedNumbers.has(d.number)))
    planDrive(pr, input.launches, plan, want);

  if (input.section.followupCommand !== null)
    for (const pr of input.merged)
      want(
        {
          stage: "followup",
          target: `PR #${pr.number}`,
          record: "forge",
          reason: `merged ${pr.mergedAt}; run ${input.section.followupCommand} ${pr.number}`,
          evidence: { url: pr.url, head: pr.head, mergedAt: pr.mergedAt },
        },
        (w) => w.prs.includes(pr.number),
      );
  return plan;
}

type Want = (action: Action, joined: (w: Workspace) => boolean) => void;

/** One driven pull request: quiet, unplaced, held by a launch record, or wanted. */
function planDrive(
  pr: DrivenPr,
  launches: ReadRecord[],
  plan: Plan,
  want: Want,
): void {
  const target = `PR #${pr.number}`;
  const hold = driveHold(pr, launches);
  if (hold.kind === "held") {
    plan.running.push({
      target,
      stage: "rearm",
      reason: hold.why,
      evidence: { record: hold.record.record.id },
    });
    return;
  }
  if (hold.kind === "refused") {
    plan.quiet.push({ target, class: "refused", why: hold.why });
    return;
  }
  const takeover = hold.kind === "takeover" ? hold.record.record.id : null;
  if (QUIET.has(pr.class) && takeover === null) {
    plan.quiet.push({ target, class: pr.class, why: pr.why });
    return;
  }
  if (pr.class === "unplaced") {
    plan.unplaced.push({ target, record: "forge", reason: pr.why });
    return;
  }
  const stage: Stage = NOTIFY.has(pr.class) ? "notify" : "rearm";
  want(
    {
      stage,
      target,
      record: "forge",
      reason:
        takeover === null
          ? `drive ledger ${pr.class}: ${pr.why}`
          : `drive ledger silent, and this machine's launch record ${takeover} started its driver: take it over (drive.ts --take-over decides)`,
      evidence: { url: pr.url, head: pr.head, ...pr.evidence },
      ...(stage === "rearm" ? { facts: factsOf(pr) } : {}),
      ...(takeover === null ? {} : { takeover }),
    },
    (w) => w.prs.includes(pr.number),
  );
}
