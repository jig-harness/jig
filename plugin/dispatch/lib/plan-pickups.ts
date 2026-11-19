/**
 * The pickups in the plan: what the tracker's assigned items want, minus
 * what the runtime's sessions and this machine's launch records hold, and
 * what the claimed items show.
 *
 * - An item in a dispatch state with no session and no launch record
 *   holding it is a pickup. One a launch record or a running session holds
 *   is running; one whose last pickup ended without claiming it is quiet
 *   until it leaves the dispatch states and comes back.
 * - An item, wanted or claimed, that more than one running session joins to
 *   (two workspaces, or a workspace beside a launch record still holding
 *   another) is a double claim: reported, nothing started for it.
 * - A claimed item (in the in-progress state) with no running session for
 *   longer than `dispatch.stalled_after` is a stalled pickup: reported,
 *   never started afresh, since that would start a second implementer on
 *   a claimed item. One whose own tree holds the work it left is relaunched
 *   once per head in that tree, to push and record it
 *   (`pickup-relaunch.ts`). A served person's item is a pickup's claim only when a
 *   pickup of this machine claimed it: its claim, noted on its launch record
 *   where `tracker.ts claim` made it (`pickup-claim.ts`), or seen while it
 *   ran. The rest of their work in progress is their own, and quiet.
 * - A claimed item with no running session whose launch's branch has an
 *   open pull request linking it is finished work, not a stall
 *   (`stalled-pr.ts`): from its in-progress state it is moved to `pr_open`,
 *   and in `pr_open` it is quiet while that pull request is open. Where it
 *   cannot move, the stall need names the pull request.
 * - A claimed item with no running session that an open pull request of the
 *   repository links, while that pull request's drive is live or converged,
 *   is carried by it, not a stall, whatever state the item is in
 *   (`carried-pr.ts`). A linked pull request with no drive, or a stopped
 *   one, leaves the stall need, which names it.
 * - A session this machine launched that the runtime reports waiting for
 *   longer than `dispatch.blocked_after` is reported; it keeps its slot.
 * - An item whose latest pickup pass ended on a question, without recording
 *   `done`, is a need: its `Question:` line is notified, and nothing is
 *   started for it, whether it was claimed or is still in a dispatch state.
 *   One whose pass ended without a question and that no rule starts again
 *   is a need too, framed with its options: pick it up again, or leave it.
 * - An item whose latest pickup stopped on a fault of its host
 *   (`pickup-host-fault.ts`) asks nothing: it is held, with the fault named,
 *   while the host's health check fails, then relaunched in its tree when
 *   claimed, or picked up afresh when not. A restart that stops on a host
 *   fault again is one need, never a second restart.
 *
 * Each report is a notification's cause, with its message and the key
 * that suppresses a repeat (`notices.ts`); `actions/notify.ts` sends it.
 */
import {
  reportEvidence,
  reportFramed,
  reportQuestion,
} from "./report-needs.ts";
import { batchPickups } from "./queue-batch.ts";
import {
  agentOf,
  endedHow,
  endedQuestion,
  holdingRecords,
  leftBehindWorkspaces,
  pickupClaimed,
  type PickupHold,
  pickupHold,
} from "./actions/pickup-hold.ts";
import { type Holding, holding, liveAgents } from "./holding.ts";
import {
  isInteractive,
  type LaunchRecord,
  type ReadRecord,
  targetOf,
} from "./launches.ts";
import { type Carriage, readCarriage } from "./carried-pr.ts";
import { holdsItem } from "./launch-pickups.ts";
import { pickupNotice } from "./notices.ts";
import { testLockNote } from "./test-lock-waits.ts";
import { unwrittenResult } from "./session-startup.ts";
import {
  faultedAgain,
  type HostFault,
  hostFault,
} from "./pickup-host-fault.ts";
import { ANY_KEY_SOURCE } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { relaunchStep, type RelaunchStep } from "./pickup-relaunch.ts";
import type { TreeReader } from "./pickup-tree.ts";
import {
  type LaunchPrReading,
  type LaunchPrStep,
  inPrOpen,
  readLaunchPr,
  type StalledPrInput,
  stallNote,
} from "./stalled-pr.ts";
import {
  type SessionsReport,
  WAITING_STATES,
  type Workspace,
} from "./runtime/port.ts";
import type {
  Action,
  ClaimedItem,
  DispatchSection,
  PrOpenMove,
  RepoReport,
  WantedItem,
} from "./types.ts";
import { isoFromMs } from "../../shared/time.ts";

export interface PickupInput {
  /** The repository's `owner/name`, which every notification names. */
  slug: string;
  section: DispatchSection;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  sessions: SessionsReport;
  launches: ReadRecord[];
  /** Since when each claimed item has been idle, as the idle clock last recorded it. */
  idleSince: ReadonlyMap<string, number>;
  nowMs: number;
  values?: Record<string, unknown>;
  /** The repository's checkout: the label taxonomy the size facet's values come from is read here. */
  root?: string;
  /** What tells a stalled pickup's finished work: the open pull requests and the `pr_open` state (`stalled-pr.ts`); absent, no claimed item is read for one. */
  prOpen?: StalledPrInput;
  /** Why the host's health check fails (`rerun-gate.ts`); `null` or absent while it passes. */
  rerunsHeld?: string | null;
  /** Reads a stalled pickup's tree for the work it left (`pickup-relaunch.ts`); absent, no stall is relaunched. */
  trees?: TreeReader;
}

export type PickupPlan = Pick<
  RepoReport,
  "actions" | "running" | "unplaced" | "quiet"
> & {
  /** The claimed items idle this tick: the idle clock runs for these and stops for the rest. */
  idleNow: string[];
  /** The claimed items whose idleness could not be told: their clock is neither started nor stopped. */
  idleKeep: string[];
  /** The stalled pickups' items to move to `pr_open`. */
  moves: PrOpenMove[];
};

/** The sessions joined to an item: running workspaces, and records holding it outside them. */
function sessionsFor(
  item: string,
  held: Holding,
  launches: ReadRecord[],
): { count: number; evidence: string; who: string } {
  const live = held.kind === "running" ? held.workspaces : [];
  const paths = new Set(live.map((w) => w.path));
  const outside = holdingRecords(item, launches).filter(
    (r) => r.record.workspace === null || !paths.has(r.record.workspace.path),
  );
  const waits = holdingRecords(item, launches).flatMap((r) => {
    const note = testLockNote(r.record);
    return note === null ? [] : [`launch record ${r.record.id} ${note}`];
  });
  const parts = [
    ...(live.length > 0 ? [liveAgents(live)] : []),
    ...outside.map(
      (r) =>
        `launch record ${r.record.id} (${r.state.kind}) in ${r.record.workspace?.path ?? "no workspace yet"}`,
    ),
    ...waits,
  ];
  const who = [
    ...live.map((w) => `workspace ${w.id}`),
    ...outside.map((r) => `record ${r.record.id}`),
  ]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(", ");
  return {
    count: live.length + outside.length,
    evidence: parts.join("; "),
    who,
  };
}

function doubleClaim(
  slug: string,
  item: { key: string; state: string },
  count: number,
  evidence: string,
  who: string,
): Action {
  const reason = `double claim: ${count} running sessions join to it, so nothing starts for it`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: { sessions: evidence },
    cause: "double-claim",
    notice: pickupNotice(
      slug,
      `${item.key} double claim, in ${item.state}, between ${who}`,
      `${item.key} ${reason} (${evidence}); a person settles which session keeps it`,
    ),
  };
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

export function planPickups(input: PickupInput): PickupPlan {
  const plan: PickupPlan = {
    actions: [],
    running: [],
    unplaced: [],
    quiet: [],
    idleNow: [],
    idleKeep: [],
    moves: [],
  };
  const { sessions, launches } = input;
  const joined = (key: string) => {
    const left = leftBehindWorkspaces(key, launches);
    return (w: Workspace) => w.items.includes(key) && !left.has(w.path);
  };

  for (const item of input.pickups) {
    const held = holding(sessions, joined(item.key));
    const { count, evidence, who } = sessionsFor(item.key, held, launches);
    if (count > 1) {
      plan.actions.push(doubleClaim(input.slug, item, count, evidence, who));
      continue;
    }
    const hold = pickupHold(item.key, launches, item.updatedAt, input.nowMs);
    if (hold.kind === "held") {
      plan.running.push({
        target: item.key,
        stage: "pickup",
        reason: hold.why,
        evidence: { record: hold.record.record.id },
      });
      continue;
    }
    if (held.kind === "unknown") {
      plan.unplaced.push({
        target: item.key,
        record: "runtime",
        reason: held.reason,
      });
      continue;
    }
    if (held.kind === "running") {
      plan.running.push({
        target: item.key,
        stage: "pickup",
        reason: `a session is running for it: ${evidence}`,
        evidence: { workspaces: held.workspaces.map((w) => w.path).join(", ") },
      });
      continue;
    }
    if (hold.kind !== "none") {
      planStopped(input, item, hold, plan);
      continue;
    }
    if (heldAfterHostFault(item.key, input, plan)) continue;
    plan.actions.push(pickupAction(item, held.evidence));
  }

  for (const item of input.claimed ?? [])
    planClaimed(item, input, plan, joined(item.key));
  planWaiting(input, plan);
  if (input.values !== undefined && input.root !== undefined)
    plan.actions = batchPickups(
      plan.actions,
      input.pickups,
      input.values,
      input.root,
    );
  return plan;
}

/**
 * An item whose latest pickup ended without claiming it: held while the
 * repository's start rules refused it, a need when its pass stopped on a
 * question, else a need that asks whether to pick it up again.
 */
function planStopped(
  input: PickupInput,
  item: WantedItem,
  hold: Extract<PickupHold, { kind: "ended" | "refused" }>,
  plan: PickupPlan,
): void {
  const why = hold.why;
  if (hold.kind === "refused") {
    plan.quiet.push({ target: item.key, class: "pickup-refused", why });
    return;
  }
  const fault = hostFault(hold.record);
  if (fault !== null) {
    stoppedOnHostFault(input, item, hold.record, fault, plan);
    return;
  }
  const asked = questionAsked(input, item, hold.record);
  if (asked !== null) {
    plan.actions.push(asked);
    return;
  }
  plan.actions.push(endedNeed(input.slug, item, hold.record, why));
}

/** An unclaimed item whose ended pickup, stopped on a host fault, still holds it: held while the health check fails, else the need that says why it is not picked up afresh. */
function stoppedOnHostFault(
  input: PickupInput,
  item: WantedItem,
  latest: ReadRecord,
  fault: HostFault,
  plan: PickupPlan,
): void {
  const held = hostHeld(fault, input);
  if (held !== null) {
    plan.quiet.push({ target: item.key, class: "pickup-ended", why: held });
    return;
  }
  const again = faultedAgain(latest, input.launches, item.key);
  const note =
    latest.record.batchItems !== undefined
      ? "a batch's pickup is not restarted on its own"
      : again !== null
        ? restartedNote(again)
        : "its pickup claimed the item before it stopped";
  plan.actions.push(hostFaultNeed(input.slug, item, latest, fault, note));
}

/** Why an item whose pickup stopped on a host fault is held this tick, or `null` while the host's health check passes. */
function hostHeld(fault: HostFault, input: PickupInput): string | null {
  const held = input.rerunsHeld ?? null;
  return held === null
    ? null
    : `its pickup stopped on a fault of this host: ${fault.why}; held while ${held}, and restarted once that passes`;
}

/** Holds an unclaimed item an ended pickup stopped on a host fault left wanted, while the host's health check fails; `true` when it did. */
function heldAfterHostFault(
  key: string,
  input: PickupInput,
  plan: PickupPlan,
): boolean {
  const latest = latestPickupFor(key, input.launches);
  const fault = latest === undefined ? null : hostFault(latest);
  const held = fault === null ? null : hostHeld(fault, input);
  if (held === null) return false;
  plan.quiet.push({ target: key, class: "pickup-ended", why: held });
  return true;
}

function restartedNote(source: ReadRecord): string {
  return `it was restarted once after its pickup stopped on a host fault (launch record ${source.record.id}) and stopped on one again, so it is not restarted a second time`;
}

/**
 * The need an item raises when its pickup stopped on a fault of its host
 * and no restart is left to it: notified once per launch record, for a
 * diagnosing session (the steward) or a person to find the fault's cause.
 */
function hostFaultNeed(
  slug: string,
  item: Pick<WantedItem, "key" | "title" | "state">,
  latest: ReadRecord,
  fault: HostFault,
  note: string,
): Action {
  const { record } = latest;
  const reason = `the pickup stopped on a fault of this host (${fault.why}), and it is not restarted: ${note}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      hostFault: fault.kind,
      ended: endedHow(latest),
    },
    cause: "pickup-ended",
    notice: pickupNotice(
      slug,
      `${item.key} host fault, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; the host's fault is diagnosed and repaired, then the item is picked up again or left`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}

/**
 * The need an item raises when its latest pickup ended without a question
 * and no rule starts it again: notified once per launch record, framed with
 * the step a person may take (release the record, or leave it).
 */
function endedNeed(
  slug: string,
  item: Pick<WantedItem, "key" | "title" | "state">,
  latest: ReadRecord,
  why: string,
): Action {
  const { record } = latest;
  const sibling = batchQuestionForSibling(latest, item.key);
  const reason = sibling
    ? "the ended batch pickup still holds this member; it can be released from the batch"
    : `the pickup ended without moving it on, and no rule starts it again: ${why}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      ...(sibling
        ? {}
        : { ended: endedHow(latest), ...reportEvidence(latest.report) }),
    },
    cause: "pickup-ended",
    ...(sibling
      ? {}
      : {
          notice: pickupNotice(
            slug,
            `${item.key} pickup ended, record ${record.id}`,
            `${item.key} (${item.title}): ${reason}; a person picks it up again or leaves it`,
          ),
        }),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}

/**
 * Why a claimed item is not one the stall watch reads as a pickup, or
 * `null` when it is: a served person's item no pickup of this machine
 * claimed is their own work; under `dispatch.stalled_scope: claimed`, so is
 * the identity's item no launch record of this machine and no claim marker
 * took.
 */
function outsideScope(
  item: ClaimedItem,
  section: DispatchSection,
  pickup: PickupHold,
  endedUnclaimed: boolean,
): string | null {
  if (item.served === true)
    return pickup.kind === "none" || endedUnclaimed
      ? `in ${item.state}, started by its served person: no pickup of this machine claimed it`
      : null;
  if (
    section.stalledScope === "claimed" &&
    item.claimMarker === undefined &&
    pickup.kind === "none"
  )
    return `in ${item.state}, claimed outside dispatch: no launch record of this machine and no claim marker took it (dispatch.stalled_scope claimed)`;
  return null;
}

/** The carriage of an item a driven pull request may carry: none for one already in pr_open, which keeps its existing handling whichever pull request links it. */
function carriageOf(
  item: ClaimedItem,
  input: PickupInput,
  pr: LaunchPrReading,
): Carriage {
  if (input.prOpen !== undefined && inPrOpen(item, input.prOpen)) {
    return { kind: "none" };
  }
  return readCarriage(
    item,
    input.prOpen?.carried,
    pr.read.kind === "open" ? pr.read.pr.number : undefined,
  );
}

/** Quiets an item a driven pull request carries, unless it is still to move to pr_open; whether it did. */
function carriedQuiet(
  item: ClaimedItem,
  carriage: Carriage,
  pr: LaunchPrReading,
  plan: PickupPlan,
): boolean {
  if (carriage.kind !== "carried" || pr.step?.kind === "move") return false;
  plan.quiet.push({
    target: item.key,
    class: "claimed-carried",
    why: carriage.why,
    carried: {
      pr: carriage.pr.number,
      url: carriage.pr.url,
      drive: carriage.drive,
    },
  });
  return true;
}

/**
 * Quiets an item its launch's open pull request settles or a driven pull
 * request carries; whether it did. An item already in pr_open under its
 * launch's open pull request is quiet whatever the pickup once asked. A move
 * goes first only when no ordinary question is recorded: the move does not
 * keep that question, and the item is quiet afterwards.
 */
function quietByPr(
  item: ClaimedItem,
  input: PickupInput,
  pr: LaunchPrReading,
  plan: PickupPlan,
  asksPerson: boolean,
): boolean {
  const settles =
    pr.step?.kind === "quiet" || (pr.step?.kind === "move" && !asksPerson);
  if (settles && settledByPr(item.key, pr.step, plan)) return true;
  return carriedQuiet(item, carriageOf(item, input, pr), pr, plan);
}

/** Whether the latest pickup ended on an ordinary question, one a person answers; a pass stopped by a fault of its host asks nothing. */
function asksPerson(latest: ReturnType<typeof latestPickupFor>): boolean {
  return (
    latest !== undefined &&
    hostFault(latest) === null &&
    endedQuestion(latest) !== null
  );
}

/** One claimed item: a double claim, running, idle, or stalled. */
function planClaimed(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  joined: (w: Workspace) => boolean,
): void {
  const held = holding(input.sessions, joined);
  const { count, evidence, who } = sessionsFor(item.key, held, input.launches);
  if (count > 1) {
    plan.actions.push(doubleClaim(input.slug, item, count, evidence, who));
    return;
  }
  if (count === 1) {
    plan.quiet.push({
      target: item.key,
      class: "claimed",
      why: `in ${item.state}, a session holds it: ${evidence}`,
    });
    return;
  }
  const pickup = pickupHold(item.key, input.launches, undefined, input.nowMs);
  // A rate-limit wait holds an ended pickup, which claims nothing by waiting.
  const endedUnclaimed =
    (pickup.kind === "ended" ||
      (pickup.kind === "held" && pickup.record.result === "waits")) &&
    !pickupClaimed(pickup.record.record, item.key);
  const why = outsideScope(item, input.section, pickup, endedUnclaimed);
  if (why !== null) {
    plan.quiet.push({ target: item.key, class: "claimed-by-person", why });
    return;
  }
  // Whether a claim marker took it could not be read (its row is already
  // unplaced): the scope is unknown, so no idle clock starts and no stall is
  // reported until a read answers. A double claim above still reports.
  if (item.claimMarker === "unread" && pickup.kind === "none") {
    plan.idleKeep.push(item.key);
    return;
  }
  if (held.kind === "unknown") {
    plan.idleKeep.push(item.key);
    plan.unplaced.push({
      target: item.key,
      record: "runtime",
      reason: held.reason,
    });
    return;
  }
  plan.idleNow.push(item.key);
  planIdleClaimed(item, input, plan, held, pickup);
}

/** An idle claimed item no session holds: settled by its pull request, relaunched, asked about, held, or planned as idle. */
function planIdleClaimed(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  held: ReturnType<typeof holding>,
  pickup: PickupHold,
): void {
  const pr = readLaunchPr(item, input.launches, input.sessions, input.prOpen);
  const latest = latestPickupFor(item.key, input.launches);
  if (quietByPr(item, input, pr, plan, asksPerson(latest))) return;
  if (hostFaultStop(item, input, plan, latest, pr)) return;
  const asked =
    pickup.kind === "ended" ? questionAsked(input, item, pickup.record) : null;
  if (asked !== null) {
    plan.actions.push(asked);
    return;
  }
  if (settledByPr(item.key, pr.step, plan)) return;
  if (
    pickup.kind === "ended" &&
    batchQuestionForSibling(pickup.record, item.key)
  ) {
    plan.actions.push(endedNeed(input.slug, item, pickup.record, pickup.why));
    return;
  }
  planIdle(item, input, plan, { held, pr, latest });
}

/**
 * A claimed item whose latest pickup stopped on a fault of its host: held
 * while the health check fails, then relaunched once in its tree to resume
 * the pickup, without waiting for `dispatch.stalled_after`; a relaunch that
 * stops on a host fault again, or a tree that cannot be relaunched, is one
 * need. `false` when the stop is not a host fault, a pull request it opened
 * moves its item first, or the relaunch rule is off, so the item is planned
 * as before.
 */
function hostFaultStop(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  latest: ReturnType<typeof latestPickupFor>,
  pr: LaunchPrReading,
): boolean {
  if (latest === undefined || pr.step?.kind === "move") return false;
  const fault = hostFault(latest);
  if (fault === null) return false;
  const again = faultedAgain(latest, input.launches, item.key);
  if (again !== null) {
    plan.actions.push(
      hostFaultNeed(input.slug, item, latest, fault, restartedNote(again)),
    );
    return true;
  }
  const held = hostHeld(fault, input);
  if (held !== null) {
    plan.quiet.push({ target: item.key, class: "pickup-ended", why: held });
    return true;
  }
  const step = relaunchStep(item, latest, { ...input, fault });
  if (step.kind === "stall") {
    plan.actions.push(
      hostFaultNeed(input.slug, item, latest, fault, step.note),
    );
    return true;
  }
  return relaunched(step, item.key, plan);
}

/** A claimed item with no session and nothing to ask: quiet until `dispatch.stalled_after`, then relaunched in its tree or reported as stalled. */
function planIdle(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  seen: {
    held: Holding;
    pr: LaunchPrReading;
    latest: ReturnType<typeof latestPickupFor>;
  },
): void {
  const since = input.idleSince.get(item.key) ?? input.nowMs;
  const idle = input.nowMs - since;
  if (idle < input.section.stalledAfterMs) {
    plan.quiet.push({
      target: item.key,
      class: "claimed-idle",
      why: `in ${item.state} with no running session for ${minutes(idle)}; reported as stalled after ${minutes(input.section.stalledAfterMs)}`,
    });
    return;
  }
  const step = relaunchStep(item, seen.latest, input);
  if (relaunched(step, item.key, plan)) return;
  plan.actions.push(
    stalledPickup(
      item,
      input,
      seen.held,
      since,
      seen.pr,
      step.kind === "stall" ? step.note : null,
    ),
  );
}

/** Whether the relaunch rule settles the stalled item for this tick: relaunched in its tree, or waiting for the host's health check. */
function relaunched(
  step: RelaunchStep,
  key: string,
  plan: PickupPlan,
): boolean {
  if (step.kind === "relaunch") {
    plan.actions.push(step.action);
    return true;
  }
  if (step.kind === "held") {
    plan.quiet.push({ target: key, class: "pickup-ended", why: step.why });
    return true;
  }
  return false;
}

/** The stall need of a claimed item idle past `dispatch.stalled_after`, naming its launch's pull request where one is open. */
function stalledPickup(
  item: ClaimedItem,
  input: PickupInput,
  held: Holding,
  since: number,
  pr: LaunchPrReading,
  treeNote: string | null,
): Action {
  const idle = input.nowMs - since;
  const carriage = carriageOf(item, input, pr);
  const notes = [
    stallNote(pr),
    carriage.kind === "stall" ? carriage.note : null,
    treeNote,
  ].filter((n): n is string => n !== null);
  const note = notes.length === 0 ? null : notes.join("; ");
  const latest = input.launches
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        (r.record.item === item.key ||
          r.record.batchItems?.some((i) => i.key === item.key)),
    )
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))[0];
  const wait =
    latest?.record.testLockWait === undefined ? "" : `; ${endedHow(latest)}`;
  const reason = `stalled pickup: in ${item.state} with no running session for ${minutes(idle)} (dispatch.stalled_after ${minutes(input.section.stalledAfterMs)}); a person settles it${note === null ? "" : `; ${note}`}${wait}`;
  return {
    stage: "notify",
    target: item.key,
    record: "tracker",
    reason,
    evidence: {
      title: item.title,
      state: item.state,
      idleSince: isoFromMs(since),
      ...(held.kind === "free" && held.evidence !== null
        ? { finishedSessions: held.evidence }
        : {}),
      ...(pr.read.kind === "open" ? { pullRequest: pr.read.pr.url } : {}),
    },
    cause: "stalled",
    notice: pickupNotice(
      input.slug,
      `${item.key} stalled, idle since ${isoFromMs(since)}`,
      `${item.key} (${item.title}): ${reason}`,
    ),
  };
}

/** Whether an open launch pull request settles the claimed item: moved to `pr_open`, or quiet in it. */
function settledByPr(
  key: string,
  step: LaunchPrStep | null,
  plan: PickupPlan,
): boolean {
  if (step?.kind === "move") {
    plan.moves.push(step.move);
    return true;
  }
  if (step?.kind === "quiet") {
    plan.quiet.push({ target: key, class: "claimed-pr-open", why: step.why });
    return true;
  }
  return false;
}

/**
 * Whether a batch question belongs elsewhere. With no named member, its
 * anchor carries the batch's question. The anchor stays fixed after release
 * so an answered question cannot reappear on a sibling.
 */
function batchQuestionForSibling(latest: ReadRecord, item: string): boolean {
  const members = latest.record.batchItems;
  if (members === undefined || members.length < 2) return false;
  const asked = endedQuestion(latest);
  if (asked === null) return false;
  const question = reportQuestion(latest.report, asked);
  const keys = new Set(
    question.toUpperCase().match(new RegExp(ANY_KEY_SOURCE, "gi")),
  );
  const named = members.filter(({ key }) => keys.has(key.toUpperCase()));
  return named.length > 0
    ? !named.some(({ key }) => key === item)
    : latest.record.item !== item;
}

/**
 * The need an item's latest pickup raises when its pass ended on a
 * question without recording `done`: the question, notified once per
 * launch record; `null` otherwise. A pass whose result or exit the host
 * could not write (`unwritten-result.ts`) asks nothing of its own: it is a
 * host fault (`hostFaultStop`), and only where the relaunch rule does not
 * take it (`dispatch.stalled_relaunch: never`, a batch's or an interactive
 * pickup) is a person asked to settle or release the item once the host's
 * health check passes.
 */
function questionAsked(
  input: Pick<PickupInput, "slug" | "rerunsHeld">,
  item: { key: string; title: string; state: string },
  latest: ReadRecord,
): Action | null {
  const { slug } = input;
  // What a pass whose result the host could not write asked is the host's fault, never a person's question.
  const unwritten = unwrittenResult(latest);
  if (unwritten && (input.rerunsHeld ?? null) !== null) return null;
  const asked = unwritten
    ? `Should ${item.key} be settled or released, whose pickup ended without a result this host could write?`
    : endedQuestion(latest);
  if (
    asked === null ||
    (!unwritten && batchQuestionForSibling(latest, item.key))
  )
    return null;
  // A pass whose result the host could not write wrote no report a person reads.
  const report = unwritten ? null : latest.report;
  const question = reportQuestion(report, asked);
  const framed = unwritten ? undefined : reportFramed(latest.framed, report);
  const { record } = latest;
  const reason = unwritten
    ? `the pickup ended without a result: this host could not write it (since ${latest.unwritten}), and its health check passes again, but the relaunch rule did not take it: ${question}`
    : `the pickup stopped on a question for a person: ${question}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      question,
      ...reportEvidence(report),
    },
    cause: "pickup-question",
    ...(framed === undefined ? {} : { framed }),
    notice: pickupNotice(
      slug,
      `${item.key} question, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; nothing starts for it until the item leaves the dispatch states and comes back`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}

/** The latest unreleased pickup for this item, shared by its question and host-health hold. */
function latestPickupFor(
  item: string,
  launches: readonly ReadRecord[],
): ReadRecord | undefined {
  return launches
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        (r.record.item === item ||
          r.record.batchItems?.some((entry) => entry.key === item) === true) &&
        holdsItem(r.record, item),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
}

/** What the tick read as a waiting session's cause: the usage-limit wall still its last record, if any. */
function waitCause(record: LaunchRecord): string {
  const latest = record.episodes?.at(-1);
  return latest?.last === true
    ? `, on its account's usage-limit wall since ${latest.observedAt} (resets ${latest.resetAt ?? "at an unknown time"})`
    : ", with no usage-limit wall read as its cause";
}

/** Each session this machine launched that has waited past `blocked_after`. */
function planWaiting(input: PickupInput, plan: PickupPlan): void {
  for (const r of input.launches) {
    const { record, state } = r;
    if (!isInteractive(record) || record.agentId === null) continue;
    if (state.kind !== "alive") continue;
    const found = agentOf(input.sessions, record.agentId);
    if (found === undefined || !WAITING_STATES.has(found.agent.state)) continue;
    const since = found.agent.since;
    if (since === null || input.nowMs - since < input.section.blockedAfterMs)
      continue;
    const target = targetOf(record);
    const reason = `session waiting: its agent has been ${found.agent.state} for ${minutes(input.nowMs - since)} (dispatch.blocked_after ${minutes(input.section.blockedAfterMs)})${waitCause(record)}; it keeps its slot until it ends or a person ends it`;
    plan.actions.push({
      stage: "notify",
      target,
      record: "runtime",
      reason,
      evidence: {
        record: record.id,
        stage: record.action,
        agent: record.agentId,
        workspace: found.workspace.path,
        account: record.account,
      },
      cause: "waiting",
      notice: pickupNotice(
        input.slug,
        `${target} waiting, record ${record.id} since ${isoFromMs(since)}`,
        `${target}: the ${record.action} session in ${found.workspace.path} ${reason}`,
      ),
      workspace: found.workspace.path,
    });
  }
}

function pickupAction(
  item: WantedItem,
  finishedSessions: string | null,
): Action {
  return {
    stage: "pickup",
    target: item.key,
    record: "tracker",
    reason:
      item.pooled === true
        ? `unassigned in the ready pool (${item.state}), made ready by ${item.assignedBy}, with no running session; its claim assigns it to ${item.assignee}`
        : `assigned to ${item.assignee} by ${item.assignedBy}, in ${item.state}, with no running session`,
    evidence: {
      title: item.title,
      url: item.url,
      state: item.state,
      assignee: item.assignee,
      assignedBy: item.assignedBy,
      ...(item.pooled === true ? { pooled: true } : {}),
      ...(item.servedPerson === undefined
        ? {}
        : { servedPerson: item.servedPerson }),
      ...(item.ancestorEpic === undefined
        ? {}
        : { ancestorEpic: item.ancestorEpic }),
      ...(item.factoryAncestor === undefined
        ? {}
        : { factoryAncestor: item.factoryAncestor }),
      ...(item.blockingFor === undefined
        ? {}
        : { blockingFor: item.blockingFor }),
      ...(finishedSessions === null
        ? {}
        : { finishedSessions: finishedSessions }),
    },
  };
}
