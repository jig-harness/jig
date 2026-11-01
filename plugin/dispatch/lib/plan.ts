/**
 * The plan: what the records want, minus what the runtime reports running.
 * Every item or pull request gets at most one action, naming the record
 * that wants it and its evidence. A target the tick cannot place (a record
 * it could not read, a runtime answer it cannot trust, a workspace whose
 * terminals the runtime cannot read) is reported and never planned. The
 * pickups' part is `plan-pickups.ts`, the follow-ups' `plan-followups.ts`.
 *
 * A notification is planned whatever sessions run for its target: telling
 * a person never competes with a session, so only a runtime answer it
 * cannot trust leaves it out.
 */
import { driveHold, factsOf } from "./actions/drive-hold.ts";
import { holding, liveAgents } from "./holding.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import type { ReadRecord } from "./launches.ts";
import { parkNotice, stopNotice } from "./notices.ts";
import { planFollowups } from "./plan-followups.ts";
import { planPickups } from "./plan-pickups.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import type {
  Action,
  ClaimedItem,
  DispatchSection,
  DrivenPr,
  LedgerClass,
  MarkedPr,
  NotifyCause,
  RepoReport,
  Running,
  Stage,
  WantedItem,
} from "./types.ts";

export interface PlanInput {
  /** The repository's `owner/name`. */
  slug: string;
  section: DispatchSection;
  pickups: WantedItem[];
  /** The items the factory identity claimed; `null` when they could not be read. */
  claimed: ClaimedItem[] | null;
  drives: DrivenPr[];
  merged: MarkedPr[];
  /** The follow-ups' outcome records, by pull request. */
  outcomes: ReadonlyMap<number, FollowupOutcome>;
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
  /** The claimed items whose clock is left as it is. */
  idleKeep: string[];
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
const NOTIFY: ReadonlyMap<LedgerClass, NotifyCause> = new Map([
  ["stopped-unknown", "stopped-unknown"],
  ["parked", "parked"],
  ["needs-person", "needs-person"],
] as const);

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
    if (held.kind === "running" && action.stage !== "notify") {
      plan.running.push({
        target: action.target,
        stage: action.stage,
        reason: `a session is running for it: ${liveAgents(held.workspaces)}`,
        evidence: { workspaces: held.workspaces.map((w) => w.path).join(", ") },
      } satisfies Running);
      return;
    }
    const evidence =
      held.kind === "running"
        ? { runningSessions: liveAgents(held.workspaces) }
        : held.evidence === null
          ? null
          : { finishedSessions: held.evidence };
    plan.actions.push(
      evidence === null
        ? action
        : { ...action, evidence: { ...action.evidence, ...evidence } },
    );
  }

  // A pull request in both populations merged between the two reads: the
  // merged state wins, so it gets its follow-up and no re-arm.
  const mergedNumbers = new Set(input.merged.map((m) => m.number));
  for (const pr of input.drives.filter((d) => !mergedNumbers.has(d.number)))
    planDrive(input.slug, pr, input.launches, plan, want);

  const command = input.section.followupCommand;
  if (command !== null)
    planFollowups(
      {
        slug: input.slug,
        command,
        merged: input.merged,
        launches: input.launches,
        outcomes: input.outcomes,
        nowMs: input.nowMs,
      },
      plan,
      want,
    );
  return plan;
}

type Want = (action: Action, joined: (w: Workspace) => boolean) => void;

/** A re-arm's ledger facts, or a notification's cause and message. */
function stageFields(
  slug: string,
  pr: DrivenPr,
  cause: NotifyCause | undefined,
): Pick<Action, "facts" | "cause" | "notice"> {
  if (cause === undefined) return { facts: factsOf(pr) };
  return {
    cause,
    notice: cause === "parked" ? parkNotice(slug, pr) : stopNotice(slug, pr),
  };
}

/** One driven pull request: quiet, unplaced, held by a launch record, or wanted. */
function planDrive(
  slug: string,
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
  const cause = NOTIFY.get(pr.class);
  const stage: Stage = cause === undefined ? "rearm" : "notify";
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
      ...stageFields(slug, pr, cause),
      ...(takeover === null ? {} : { takeover }),
    },
    (w) => w.prs.includes(pr.number),
  );
}
