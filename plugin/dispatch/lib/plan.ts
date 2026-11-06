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
 *
 * A pull request a person's `hold` label stands the dispatcher down from
 * gets no action of any stage: each one the records want is reported as
 * held instead, and planned again once the label is gone.
 *
 * A pull request held behind another in a serialized change area
 * (`contention.ts`) gets no re-arm, takeover or re-drive: each is reported
 * as `held: serialized behind #N in <area>`, and the group's leader is
 * planned as any pull request is. A pull request whose place in a group
 * cannot be told this tick gets none either, reported as unplaced. Its
 * notifications go on: a hold keeps the dispatcher's own launches off,
 * not a person's view of the pull request.
 *
 * Where another host dispatches the repository too, its launch claims are
 * read beside this host's launch records (`shared-launches.ts`): a drive
 * another host's claim holds is reported as held by that host and never
 * started here; a refusal, a re-drive of the same change or an arm at the
 * same head it made counts as this host's would; and a silent driver its
 * launch started is taken over from here. Claims that cannot be read leave
 * the pull request unplaced.
 */
import { type DriveHold, driveHold, factsOf } from "./actions/drive-hold.ts";
import { type Contention, heldReason } from "./contention.ts";
import { holding, liveAgents } from "./holding.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import type { FollowupRelease } from "./followup-releases.ts";
import { planDrift } from "./expectations.ts";
import { isDrive, type ReadRecord } from "./launches.ts";
import { parkNotice, stopNotice } from "./notices.ts";
import { planFollowups } from "./plan-followups.ts";
import { planPickups } from "./plan-pickups.ts";
import {
  type DriveClaims,
  type ForeignHold,
  foreignHold,
} from "./shared-launches.ts";
import { failed } from "../../shared/outcome.ts";
import { planStuck } from "./stuck-launches.ts";
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
  /** The stale follow-up claims this host released, by pull request. */
  releases?: ReadonlyMap<number, FollowupRelease>;
  sessions: SessionsReport;
  /** Each pull request's creation time; a pickup's pull request is one created after its launch. */
  created?: ReadonlyMap<number, string>;
  /** This machine's launch records for the repository. */
  launches: ReadRecord[];
  /** Since when each claimed item has been idle (the idle clock). */
  idleSince: ReadonlyMap<string, number>;
  /** The pull requests that carry a person's `hold` label. */
  held?: ReadonlySet<number>;
  /** Under `only_labeled`: the pull requests read and found labelled. An action on any other pull request is withheld. */
  inScope?: ReadonlySet<number>;
  /** The pull requests serialization holds, or cannot place, this tick. */
  serialized?: Pick<Contention, "held" | "unplaced">;
  /** The shared records read this tick: this host, and each drive's launch claims (`shared-launches.ts`). */
  shared?: { host: string; drives: DriveClaims; owner?: boolean };
  nowMs: number;
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet"> & {
  /** The claimed items idle this tick, for the idle clock. */
  idleNow: string[];
  /** The claimed items whose clock is left as it is. */
  idleKeep: string[];
  /** The actions a `hold` label kept off. */
  held: Array<{ target: string; stage: Stage; reason: string }>;
  /** The targets `only_labeled` withheld actions from: their notice records stand. */
  withheld: string[];
  /** The re-arms, takeovers and re-drives a serialized area's hold kept off. */
  serialHeld: Array<{ target: string; stage: Stage; reason: string }>;
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
  const plan: Plan = {
    ...planPickups(input),
    held: [],
    withheld: [],
    serialHeld: [],
  };

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
    planDrive(input, pr, plan, want);

  const command = input.section.followupCommand;
  if (command !== null)
    planFollowups(
      {
        slug: input.slug,
        command,
        merged: input.merged,
        launches: input.launches,
        outcomes: input.outcomes,
        host: input.shared?.host ?? null,
        sessions,
        staleAfterMs: input.section.followupStaleAfterMs,
        releases: input.releases ?? new Map(),
        owner: input.shared?.owner ?? true,
        nowMs: input.nowMs,
      },
      plan,
      want,
    );

  // The running stages that drift from their expectation, once the waiting
  // notifications are known: one stands in for the other.
  const drift = planDrift({
    slug: input.slug,
    section: input.section,
    launches: input.launches,
    sessions,
    created: input.created ?? new Map(),
    itemStates: new Map([
      ...input.pickups.map((p) => [p.key, p.state] as const),
      ...(input.claimed ?? []).map((c) => [c.key, c.state] as const),
    ]),
    waiting: new Set(
      plan.actions
        .filter((a) => a.cause === "waiting")
        .map((a) => String(a.evidence.record)),
    ),
    nowMs: input.nowMs,
  });
  plan.actions.push(...drift.actions);
  plan.running.push(...drift.running);
  // A pending record no tick launches again waits on a person.
  plan.actions.push(...planStuck(input.slug, input.launches));
  holdBack(plan, input.held ?? new Set(), input.inScope);
  if (input.serialized !== undefined) serialBack(plan, input.serialized);
  return plan;
}

/**
 * Move each drive's re-arm (a takeover and a re-drive among them) on a pull
 * request serialization holds out of the plan, into its report; one on a
 * pull request whose place serialization cannot tell this tick is unplaced.
 */
function serialBack(
  plan: Pick<Plan, "actions" | "serialHeld" | "unplaced">,
  serialized: Pick<Contention, "held" | "unplaced">,
): void {
  const kept: Action[] = [];
  for (const action of plan.actions) {
    const pr = /^PR #(\d+)$/.exec(action.target);
    const n = pr === null || action.stage !== "rearm" ? null : Number(pr[1]);
    const why = n === null ? undefined : serialized.unplaced.get(n);
    const hold = n === null ? undefined : serialized.held.get(n);
    if (why !== undefined)
      plan.unplaced.push({
        target: action.target,
        record: "forge",
        reason: why,
      });
    else if (hold !== undefined)
      plan.serialHeld.push({
        target: action.target,
        stage: action.stage,
        reason: `${heldReason(hold)}; without it the tick would ${action.takeover === undefined ? "rearm" : "take over"}: ${action.reason}`,
      });
    else kept.push(action);
  }
  plan.actions = kept;
}

/**
 * Move every action on a pull request a `hold` label carries out of the
 * plan, into its report. Under `only_labeled` (`inScope` given) an action
 * on a pull request not positively known to be labelled is withheld, so a
 * listing that failed or never held the pull request leaves it alone.
 */
export function holdBack(
  plan: Pick<Plan, "actions" | "held"> & { withheld?: string[] },
  held: ReadonlySet<number>,
  inScope?: ReadonlySet<number>,
): void {
  if (held.size === 0 && inScope === undefined) return;
  const targets = new Set([...held].map((n) => `PR #${n}`));
  const scoped =
    inScope === undefined ? null : new Set([...inScope].map((n) => `PR #${n}`));
  const kept: Action[] = [];
  for (const action of plan.actions)
    if (
      scoped !== null &&
      /^PR #\d+$/.test(action.target) &&
      !scoped.has(action.target)
    )
      plan.withheld?.push(action.target);
    else if (targets.has(action.target)) {
      plan.held.push({
        target: action.target,
        stage: action.stage,
        reason: `a person's hold label stands the dispatcher down from it; without it the tick would ${action.stage}: ${action.reason}`,
      });
      plan.withheld?.push(action.target);
    } else kept.push(action);
  plan.actions = kept;
}

type Want = (action: Action, joined: (w: Workspace) => boolean) => void;

/** A re-arm's ledger facts, or a notification's cause and message. */
function stageFields(
  slug: string,
  pr: DrivenPr,
  cause: NotifyCause | undefined,
  launches: ReadRecord[],
): Pick<Action, "facts" | "redrive" | "cause" | "notice" | "launched"> {
  if (cause === undefined)
    return {
      facts: factsOf(pr),
      ...(pr.stale === undefined ? {} : { redrive: pr.stale }),
    };
  return {
    cause,
    notice: cause === "parked" ? parkNotice(slug, pr) : stopNotice(slug, pr),
    ...(stoppedOurs(pr, launches) ? { launched: true as const } : {}),
  };
}

/** How long after its ledger's last write a stopped driver's wrapper may still be recorded exiting. */
const EXIT_SLACK_MS = 60_000;

/**
 * Whether this machine's latest drive of the pull request produced the stop
 * its ledger shows: it ended with the ledger's exit, and the ledger was last
 * written between its launch and its exit, so its ended row holds the stop.
 * A stop written after the exit is another driver's.
 */
function stoppedOurs(pr: DrivenPr, launches: ReadRecord[]): boolean {
  const latest = launches
    .filter((r) => isDrive(r.record) && r.record.pr === pr.number)
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
  if (
    latest === undefined ||
    latest.state.kind !== "ended" ||
    latest.state.exit.code !== (pr.evidence.exit ?? null)
  )
    return false;
  const beat = Date.parse(String(pr.evidence.heartbeat));
  return (
    Number.isFinite(beat) &&
    beat >= Date.parse(latest.record.createdAt) &&
    beat <= Date.parse(latest.state.exit.at) + EXIT_SLACK_MS
  );
}

/** Another host's launch claim whose launch started the driver a takeover replaces. */
type TakeoverClaim = NonNullable<Action["takeoverClaim"]>;

/** The launch-record holds that leave a drive quiet, by the class the report gives it. */
const QUIET_HOLDS: ReadonlyMap<DriveHold["kind"], LedgerClass> = new Map([
  ["refused", "refused"],
  ["redriven", "stale"],
  ["armed", "unarmed"],
]);

/** Why the plan wants a drive's action, in one sentence. */
function wantReason(
  pr: DrivenPr,
  takeover: string | null,
  claim: TakeoverClaim | null,
): string {
  if (takeover !== null)
    return `drive ledger silent, and this machine's launch record ${takeover} started its driver: take it over (drive.ts --take-over decides)`;
  if (claim !== null)
    return `drive ledger silent, and host ${claim.host}'s launch claim (comment ${claim.id}, its launch record ${claim.record}) started its driver: take it over (drive.ts --take-over decides)`;
  const source =
    pr.class !== "unarmed"
      ? "drive ledger"
      : typeof pr.evidence.adopted === "string"
        ? "adoption rule"
        : "drive label";
  return `${source} ${pr.class}: ${pr.why}`;
}

/** The ledger classes a launch can start from, which another host's claims are read beside. */
const LAUNCHABLE: ReadonlySet<LedgerClass> = new Set([
  "silent",
  "stale",
  "re-armable",
  "unarmed",
]);

/** The holds of another host's claims that leave a drive quiet, by the class the report gives it. */
const FOREIGN_QUIET: ReadonlyMap<ForeignHold["kind"], LedgerClass> = new Map([
  ["refused", "refused"],
  ["redriven", "stale"],
  ["armed", "unarmed"],
]);

/**
 * Another host's claims beside a drive this host's records leave open:
 * `true` when they placed it (held, quiet or unplaced), else the takeover of
 * a driver another host started, or `null`.
 */
function planForeign(
  input: PlanInput,
  pr: DrivenPr,
  plan: Plan,
): true | TakeoverClaim | null {
  const shared = input.shared;
  if (shared === undefined || !LAUNCHABLE.has(pr.class)) return null;
  const target = `PR #${pr.number}`;
  const claims =
    shared.drives.get(pr.number) ??
    failed("unreadable", "they were not read this tick");
  const hold = foreignHold(pr, claims, shared.host);
  if (hold.kind === "none") return null;
  if (hold.kind === "unread") {
    plan.unplaced.push({ target, record: "forge", reason: hold.why });
    return true;
  }
  const says = hold.claim.says.value;
  if (hold.kind === "takeover")
    return {
      id: hold.claim.id,
      host: String(says.host),
      record: String(says.record),
    };
  if (hold.kind === "held") {
    plan.running.push({
      target,
      stage: "rearm",
      reason: `held by host ${String(says.host)}: ${hold.why}`,
      evidence: { claim: hold.claim.id, host: says.host, record: says.record },
    });
    return true;
  }
  plan.quiet.push({
    target,
    class: FOREIGN_QUIET.get(hold.kind) ?? pr.class,
    why: hold.why,
  });
  return true;
}

/** One driven pull request: quiet, unplaced, held by a launch record or another host's claim, or wanted. */
function planDrive(
  input: PlanInput,
  pr: DrivenPr,
  plan: Plan,
  want: Want,
): void {
  const { slug, launches } = input;
  const target = `PR #${pr.number}`;
  const hold = driveHold(pr, launches);
  if (placedByHold(target, hold, plan)) return;
  const takeover = hold.kind === "takeover" ? hold.record.record.id : null;
  // Another host's open takeover on these ledger facts holds the drive even
  // where this host's own record would take it over.
  const placed = planForeign(input, pr, plan);
  if (placed === true) return;
  const foreign = takeover === null ? placed : null;
  if (QUIET.has(pr.class) && takeover === null && foreign === null) {
    plan.quiet.push({ target, class: pr.class, why: pr.why });
    return;
  }
  if (pr.class === "unplaced") {
    plan.unplaced.push({ target, record: "forge", reason: pr.why });
    return;
  }
  const cause = NOTIFY.get(pr.class);
  want(
    {
      stage: cause === undefined ? "rearm" : "notify",
      target,
      record: "forge",
      reason: wantReason(pr, takeover, foreign),
      evidence: { url: pr.url, head: pr.head, ...pr.evidence },
      ...stageFields(slug, pr, cause, launches),
      ...takeoverFields(takeover, foreign),
    },
    (w) => w.prs.includes(pr.number),
  );
}

/** Whether this machine's launch records placed a drive: held by a record, or quiet behind one. */
function placedByHold(target: string, hold: DriveHold, plan: Plan): boolean {
  if (hold.kind === "held") {
    plan.running.push({
      target,
      stage: "rearm",
      reason: hold.why,
      evidence: { record: hold.record.record.id },
    });
    return true;
  }
  const quiet = QUIET_HOLDS.get(hold.kind);
  if (quiet === undefined || !("why" in hold)) return false;
  plan.quiet.push({ target, class: quiet, why: hold.why });
  return true;
}

/** A takeover's fields: the launch record whose driver it replaces, or the claim of another host's that started it. */
function takeoverFields(
  takeover: string | null,
  claim: TakeoverClaim | null,
): Pick<Action, "takeover" | "takeoverClaim"> {
  if (takeover !== null) return { takeover };
  return claim === null ? {} : { takeoverClaim: claim };
}
