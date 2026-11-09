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
 *
 * A silent driver that no launch record and no launch claim started is taken
 * over when it ran on this host and this host shows its run ended
 * (`driverGone`, `sources/silent-driver.ts`), a re-drive the pull request's
 * recovery budget counts, or when the repository clone's drive doctor reads
 * its holder `DEAD` or `WEDGED` (`sources/doctor.ts`); otherwise it is
 * reported with the doctor's reading. `drive.ts --take-over` decides whether
 * a takeover is admitted.
 */
import { type DriveHold, driveHold, factsOf } from "./actions/drive-hold.ts";
import { type BoardRead, readyActions } from "./board.ts";
import { type Contention, heldReason } from "./contention.ts";
import { holding, liveAgents } from "./holding.ts";
import type { FollowupOutcome } from "./followup-outcomes.ts";
import type { FollowupRelease } from "./followup-releases.ts";
import { planDrift } from "./expectations.ts";
import { isDrive, type ReadRecord } from "./launches.ts";
import { parkNotice, stopNotice } from "./notices.ts";
import { goneUnlaunched } from "./recovery-facts.ts";
import { idleBlocksStart } from "./automation.ts";
import { backingOff } from "./infra-backoff.ts";
import { conflictNote } from "./sources/ledgers.ts";
import { requestedTree, workspaceOfTree } from "./stall-tree.ts";
import { planFollowups } from "./plan-followups.ts";
import { planPickups } from "./plan-pickups.ts";
import {
  type DriveClaims,
  type ForeignHold,
  foreignHold,
} from "./shared-launches.ts";
import { failed } from "../../shared/outcome.ts";
import { type HolderReadings, orphanTakeover } from "./sources/doctor.ts";
import { UNCLAIMED_AFTER_MS } from "./machine-config.ts";
import { planStuck } from "./stuck-launches.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import type {
  Action,
  ClaimedItem,
  DispatchSection,
  DrivenPr,
  HolderReading,
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
  /** The board read: the converged pull requests it placed, notified as they enter Ready to merge. */
  board?: BoardRead;
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
  /** The launch records whose follow-up marker a tick released as a retry (`settledEnds`). */
  retried?: ReadonlySet<string>;
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
  /** Each pull request's lock holder as this clone's drive doctor reads it, where a silent drive had it read (`sources/doctor.ts`). */
  holders?: HolderReadings;
  /** The machine file's `unclaimed_after`: past it, a launch answered as started that no wrapper claimed is stuck. */
  unclaimedAfterMs?: number;
  nowMs: number;
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet"> & {
  /** The claimed items idle this tick, for the idle clock. */
  idleNow: string[];
  /** The claimed items whose clock is left as it is. */
  idleKeep: string[];
  /** The actions a `hold` label kept off. */
  held: Array<{
    target: string;
    stage: Stage;
    reason: string;
    cause?: NotifyCause;
  }>;
  /** The targets `only_labeled` withheld actions from: their notice records stand. */
  withheld: string[];
  /** The re-arms, takeovers and re-drives a serialized area's hold kept off. */
  serialHeld: Array<{ target: string; stage: Stage; reason: string }>;
};

/** The ledger classes that need nothing from the tick but a line in the report. */
const QUIET: ReadonlySet<LedgerClass> = new Set([
  "driven",
  "done",
  "stopped-by-person",
  "refused",
]);

/** The ledger classes a person must settle: notified, never re-armed. */
const NOTIFY: ReadonlyMap<LedgerClass, NotifyCause> = new Map([
  ["stopped-unknown", "stopped-unknown"],
  ["parked", "parked"],
  ["needs-person", "needs-person"],
  ["silent", "needs-person"],
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
        retried: input.retried ?? new Set(),
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
  plan.actions.push(...readyActions(input.slug, input.board));
  // A pending record no tick launches again waits on a person.
  plan.actions.push(
    ...planStuck(input.slug, input.launches, {
      nowMs: input.nowMs,
      unclaimedAfterMs: input.unclaimedAfterMs ?? UNCLAIMED_AFTER_MS,
      sessions,
    }),
  );
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
        ...(action.cause === undefined ? {} : { cause: action.cause }),
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

/** What showed a silent driver no launch started gone, when this host may take it over; `null` otherwise. */
function goneDriver(pr: DrivenPr): string | null {
  return goneUnlaunched(pr) ? String(pr.evidence.driverCheck) : null;
}

/** Why the plan wants a drive's action, in one sentence. */
function wantReason(
  pr: DrivenPr,
  takeover: string | null,
  claim: TakeoverClaim | null,
  holder: HolderReading | null,
  gone: string | null = null,
): string {
  if (gone !== null)
    return `drive ledger silent, no launch started its driver, and this host shows its run ended (${gone}): take it over (drive.ts --take-over decides)`;
  if (takeover !== null)
    return `drive ledger silent, and this machine's launch record ${takeover} started its driver: take it over (drive.ts --take-over decides)`;
  if (claim !== null)
    return `drive ledger silent, and host ${claim.host}'s launch claim (comment ${claim.id}, its launch record ${claim.record}) started its driver: take it over (drive.ts --take-over decides)`;
  if (holder !== null)
    return `drive ledger silent, no launch started its driver, and this clone's drive doctor reads its holder ${holder.verdict} (${holder.reason}): take it over (drive.ts --take-over decides)`;
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
  "stopped-unknown",
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
  if (
    hold.kind === "none" ||
    (hold.kind === "refused" &&
      pr.class === "stopped-unknown" &&
      pr.evidence.noCause === true)
  )
    return null;
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

/**
 * A stall re-drive bound to the tree that holds the work it left: `null`
 * where that tree is another host's, whose dispatcher re-drives it there; a
 * person's where it is this host's and no open workspace holds it, since a
 * fresh tree would not carry the work; else the drive as it reads. Unread
 * sessions leave it as it reads, for the plan's own report of them.
 */
function treeBound(pr: DrivenPr, sessions: SessionsReport): DrivenPr | null {
  const tree = pr.stale?.tree ?? requestedTree(pr);
  if (tree === undefined) return pr;
  if (!tree.here) return null;
  if (
    !sessions.ok ||
    workspaceOfTree(sessions.workspaces, tree.actor) !== undefined
  )
    return pr;
  const { stale: _bound, ...rest } = pr;
  return {
    ...rest,
    class: "needs-person",
    why: `${pr.stale?.cause ?? pr.why}, leaving work in its tree (${tree.actor}), which no open workspace on this host holds: a fresh tree would not carry the work, so a person recovers it${conflictNote(pr.evidence.mergeable)} (see the drive's handoff)`,
  };
}

/** Why an automation pull request's drive is not started again of itself: it needs no work. `null` for any other drive, and for a person's rearm request. */
function idleWhy(pr: DrivenPr): string | null {
  if (!idleBlocksStart(pr)) return null;
  return `${pr.why}; but it is an automation pull request that needs no work (no failing check, no conflict, no unresolved thread), so nothing is started of itself: a person merges it, or labels it rearm`;
}

/**
 * The drive as this host plans it, or `null` once it is reported quiet
 * because nothing is launched for it yet: its work is in a tree on another
 * host, its re-drive waits out a backoff, or it is an automation pull
 * request that needs no work.
 */
function plannable(
  input: PlanInput,
  read: DrivenPr,
  plan: Plan,
): DrivenPr | null {
  const target = `PR #${read.number}`;
  const pr = treeBound(read, input.sessions);
  if (pr === null) {
    plan.quiet.push({
      target,
      class: read.class,
      why: `${read.why}; that tree is on another host, whose dispatcher re-drives it there`,
    });
    return null;
  }
  const waiting = backingOff(pr, input.nowMs) ?? idleWhy(pr);
  if (waiting === null) return pr;
  plan.quiet.push({ target, class: pr.class, why: waiting });
  return null;
}

/** One driven pull request: quiet, unplaced, held by a launch record or another host's claim, or wanted. */
function planDrive(
  input: PlanInput,
  read: DrivenPr,
  plan: Plan,
  want: Want,
): void {
  const { slug, launches } = input;
  const target = `PR #${read.number}`;
  const pr = plannable(input, read, plan);
  if (pr === null) return;
  const hold = driveHold(pr, launches);
  if (
    !(
      hold.kind === "refused" &&
      pr.class === "stopped-unknown" &&
      pr.evidence.noCause === true
    ) &&
    placedByHold(target, hold, plan)
  )
    return;
  const takeover = hold.kind === "takeover" ? hold.record.record.id : null;
  // Another host's open takeover on these ledger facts holds the drive even
  // where this host's own record would take it over.
  const placed = planForeign(input, pr, plan);
  if (placed === true) return;
  const foreign = takeover === null ? placed : null;
  const { holder, gone, unread } = orphanReading(pr, input, takeover, foreign);
  const taken =
    takeover !== null || foreign !== null || holder !== null || gone !== null;
  if (QUIET.has(pr.class) && !taken) {
    plan.quiet.push({ target, class: pr.class, why: pr.why });
    return;
  }
  if (pr.class === "unplaced") {
    plan.unplaced.push({ target, record: "forge", reason: pr.why });
    return;
  }
  const cause = taken ? undefined : NOTIFY.get(pr.class);
  const staged = unread === null ? pr : { ...pr, why: unread };
  want(
    {
      stage: cause === undefined ? "rearm" : "notify",
      target,
      record: "forge",
      reason: unread ?? wantReason(pr, takeover, foreign, holder, gone),
      evidence: { url: pr.url, head: pr.head, ...pr.evidence },
      ...stageFields(slug, staged, cause, launches),
      ...takeoverFields(takeover, foreign, holder, gone),
    },
    (w) => w.prs.includes(pr.number),
  );
}

/**
 * A silent driver no launch started is taken over once this clone's doctor
 * reads its holder dead or wedged; otherwise a person is notified with the
 * doctor's reading.
 */
function orphanReading(
  pr: DrivenPr,
  input: PlanInput,
  takeover: string | null,
  foreign: TakeoverClaim | null,
): {
  holder: HolderReading | null;
  gone: string | null;
  unread: string | null;
} {
  if (takeover !== null || foreign !== null)
    return { holder: null, gone: null, unread: null };
  const gone = goneDriver(pr);
  if (pr.class !== "silent" || gone !== null)
    return { holder: null, gone, unread: null };
  if (pr.evidence.settled === true)
    return { holder: null, gone: null, unread: pr.why };
  const orphan = orphanTakeover(pr, input.holders);
  return "why" in orphan
    ? { holder: null, gone: null, unread: orphan.why }
    : { holder: orphan.holder, gone: null, unread: null };
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

/** A takeover's fields: the launch record whose driver it replaces, the claim of another host's that started it, or the holder the doctor read. */
function takeoverFields(
  takeover: string | null,
  claim: TakeoverClaim | null,
  holder: HolderReading | null,
  gone: string | null,
): Pick<
  Action,
  "takeover" | "takeoverClaim" | "takeoverHolder" | "takeoverGone"
> {
  if (takeover !== null) return { takeover };
  if (claim !== null) return { takeoverClaim: claim };
  if (gone !== null) return { takeoverGone: gone };
  return holder === null ? {} : { takeoverHolder: holder };
}
