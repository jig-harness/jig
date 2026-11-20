/**
 * The `pickup` station of a tracker item: who holds its pick-up, whether it
 * is assigned, claimed, stalled or doubly claimed, and how its last session
 * ended. The tracker claim (the item's assignee and its in-progress state)
 * is the pick-up's shared record, read through the tracker interface the
 * repository's configuration names; on the machine that dispatched it, its
 * launch record, its rows in the outcome log and the newest tick's line add
 * the session and what the tick found waiting on a person.
 */
import { layeredConfig } from "../../shared/consumer.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { TrackerKeyForm } from "../../shared/address.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type TrackerConfig,
  trackerConfigFrom,
} from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { issueKeysOf } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { remoteUrl } from "../../skills/do-item/scripts/lib/tracker/github/refs.ts";
import type {
  CanonicalState,
  Issue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { dispatchSection } from "../../dispatch/lib/section.ts";
import { lastEnded } from "../../dispatch/lib/log.ts";
import type {
  LineNeed,
  LineQueued,
} from "../../dispatch/lib/dashboard-contract.ts";
import {
  type PersonPickupHold,
  personPickupHolds,
  pickupHoldReason,
} from "../../dispatch/lib/person-pickup-holds.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import {
  type Holder,
  personWait,
  type ThreadEntry,
  type WaitsOn,
} from "./answer.ts";
import { PAST_DEADLINE, within } from "./reading.ts";
import {
  type AskContext,
  dispatcherReads,
  holdingRecord,
  lastOfRow,
  nothing,
  recordHolder,
  type StationAnswer,
} from "./station.ts";
import { localLaunchEntries, logEntries } from "./thread.ts";
import { personAct } from "./waiting.ts";
import { actOfLineNeed } from "../../shared/acts.ts";
import { lineNeeds, lineQueue } from "./line-needs.ts";

/** A repository's tracker, from the configuration of its checkout at `root`. */
export interface RepoTracker {
  config: TrackerConfig;
  keys: TrackerKeyForm;
  root: string;
  /** The factory identity whose assigned items are pickups; `null` when the repository names none. */
  identity: string | null;
  /** The canonical states `dispatch.states` lists, where an assigned item waits to be picked up. */
  states: string[];
}

/** The tracker of the checkout at `root`, or why it is not known. */
export function trackerAt(
  root: string,
): Outcome<RepoTracker, "unknown-tracker"> {
  const values = attempt(
    "unknown-tracker",
    "the configuration does not read",
    () => layeredConfig(root).values,
  );
  if (!values.ok) return values;
  const config = attempt(
    "unknown-tracker",
    "the tracker configuration does not read",
    () => trackerConfigFrom(values.value),
  );
  if (!config.ok) return config;
  const keys = issueKeysOf(config.value, () => remoteUrl(root));
  if (keys === null)
    return failed(
      "unknown-tracker",
      "the configuration names no tracker team, so its item keys have no form",
    );
  const section = dispatchSection(values.value);
  return ok({
    config: config.value,
    keys: (input) => keys.normalize(input),
    root,
    identity: section.ok ? section.value.identity : null,
    states: section.ok ? section.value.states : [],
  });
}

const DONE_TYPES = new Set(["completed", "canceled", "duplicate"]);

/** The newest tick's needs about this item. */
function needsOf(ctx: AskContext): LineNeed[] {
  return lineNeeds(ctx).filter((n) => n.item === ctx.address.key);
}

/** The tick's needs that still hold of the item as the tracker reads it now: a closed item, or one the factory identity no longer holds or waits on, has none. */
function currentNeeds(
  needs: LineNeed[],
  issue: Issue,
  identity: string | null,
  member: Membership,
): LineNeed[] {
  if (DONE_TYPES.has(issue.state.type)) return [];
  if (
    identity !== null &&
    member.claimed === false &&
    member.assigned === false
  )
    return [];
  return needs;
}

/** Whether the tracker lists the item among the factory identity's claims and its waiting assignments, as the dispatcher reads them; `null` when a list did not read. */
interface Membership {
  claimed: boolean | null;
  assigned: boolean | null;
}

function stateOf(
  issue: Issue,
  identity: string | null,
  needs: readonly LineNeed[],
  member: Membership,
): { state: string; detail: string } {
  const where = `${issue.state.name} (${issue.state.type || "no category"})`;
  if (DONE_TYPES.has(issue.state.type))
    return { state: "closed", detail: where };
  const double = needs.find((n) => n.cause === "double-claim");
  if (double !== undefined)
    return { state: "doubly claimed", detail: double.reason };
  const stalled = needs.find((n) => n.cause === "stalled");
  if (stalled !== undefined)
    return { state: "stalled", detail: stalled.reason };
  const who = issue.assignee ?? "nobody";
  if (member.claimed === true)
    return { state: "claimed", detail: `${where}, assigned to ${who}` };
  if (member.assigned === true && identity !== null)
    return {
      state: "assigned",
      detail: `${where}, assigned to the factory identity ${identity}`,
    };
  if (
    identity !== null &&
    (member.claimed === null || member.assigned === null)
  )
    return {
      state: "unknown",
      detail: `${where}, assigned to ${who}; the tracker's lists of ${identity}'s items did not read, so whether the dispatcher holds it is not known`,
    };
  return { state: "not assigned", detail: `${where}, assigned to ${who}` };
}

/** The need's reason, and why the tick did not read the answers to its decisions, where it did not. */
function needWhy(need: LineNeed): string {
  const unread = need.decisions.flatMap((d) =>
    d.unread === undefined ? [] : [`its answers are unreadable: ${d.unread}`],
  );
  return [need.reason, ...unread].join("; ");
}

/** The newest tick's queue entry for this item as an assigned pickup, where it planned one. */
function queuedOf(ctx: AskContext): LineQueued | undefined {
  return lineQueue(ctx).find(
    (q) => q.item === ctx.address.key && q.source === "assigned",
  );
}

function waitsOnOf(
  state: string,
  needs: readonly LineNeed[],
  ctx: AskContext,
  held: boolean,
  queued: LineQueued | undefined,
): WaitsOn {
  // The tick's own need comes first: a session that runs may be the one waiting on a person.
  const need = needs[0];
  if (need !== undefined)
    return personWait(personAct(need.cause), needWhy(need), {
      act: actOfLineNeed(need),
    });
  if (held) return "none";
  if (state === "assigned" && queued?.overlap !== undefined)
    return { waiting: queued.overlap.text };
  if (state === "assigned" && ctx.dispatches)
    return { waiting: "the dispatcher's next tick, which starts the pick-up" };
  return "none";
}

/**
 * One tracker read under its source's deadline, counted: its value, or why
 * there is none (the deadline, no answer in time, or what the adapter threw).
 */
async function trackerRead<T>(
  ctx: AskContext,
  work: () => Promise<T>,
): Promise<{ value: T } | { why: string }> {
  const sec = ctx.reading.sourceSec();
  if (sec === 0) return { why: PAST_DEADLINE };
  ctx.reading.trackerCall();
  try {
    return (
      (await within(sec, work)) ?? {
        why: `the tracker did not answer within ${sec} s`,
      }
    );
  } catch (error) {
    return {
      why: `the tracker's read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The factory identity's claimed and waiting items, as the dispatcher reads them (the tracker resolves the identity), and whether this item is among them. */
async function membershipOf(
  ctx: AskContext,
  tracker: RepoTracker,
): Promise<Membership> {
  const { identity } = tracker;
  if (identity === null) return { claimed: false, assigned: false };
  const key = ctx.address.key;
  const listed = async (
    states: ReadonlyArray<CanonicalState>,
  ): Promise<boolean | null> => {
    if (states.length === 0) return false;
    const read = await trackerRead(ctx, () =>
      openTracker(tracker.config, tracker.root).assignedIssues(
        identity,
        states,
      ),
    );
    return "value" in read
      ? read.value.some((i) => i.identifier === key)
      : null;
  };
  const claimed = await listed(["in_progress"]);
  const assigned = await listed(tracker.states as CanonicalState[]);
  ctx.reading.note({
    record: "tracker-assignment-list",
    read: claimed !== null && assigned !== null,
    ...(claimed !== null && assigned !== null
      ? {}
      : { detail: `the items assigned to ${identity} did not read` }),
  });
  return { claimed, assigned };
}

/** Who holds a pick-up nobody on this machine launched: the tracker claim's assignee, where the item is claimed. */
function claimHolder(state: string, issue: Issue): Holder | "none" {
  if (state !== "claimed" && state !== "stalled" && state !== "doubly claimed")
    return "none";
  return {
    stage: "pickup",
    host: "unknown",
    generation: null,
    process: "unknown",
    why: `the tracker claim names ${issue.assignee ?? "nobody"}; which session holds it is the dispatching machine's to know`,
  };
}

/** The `pickup` station's answer. */
export async function askPickup(
  ctx: AskContext,
  tracker: RepoTracker,
): Promise<StationAnswer> {
  return (await readPickup(ctx, tracker)).answer;
}

/** The `pickup` station's answer, and the item as the tracker read it (`null` when it did not read or names none): for `jig send`, which checks a request against it. */
export async function readPickup(
  ctx: AskContext,
  tracker: RepoTracker,
): Promise<{ answer: StationAnswer; issue: Issue | null }> {
  const { reading, address } = ctx;
  const found = await trackerRead(ctx, () =>
    openTracker(tracker.config, tracker.root).getIssue(address.key),
  );
  if ("why" in found) {
    reading.note({ record: "tracker-claim", read: false, detail: found.why });
    return {
      answer: { ...nothing("unknown", found.why), found: true },
      issue: null,
    };
  }
  reading.note({
    record: "tracker-claim",
    read: true,
    ...(found.value === null ? { detail: "no such item" } : {}),
  });
  if (found.value === null)
    return {
      answer: nothing("no such item", `the tracker has no item ${address.key}`),
      issue: null,
    };
  const issue = found.value;
  return { answer: await issueAnswer(ctx, tracker, issue), issue };
}

/** The item's state with the person's hold on it, and the hold's own reading: why it did not read, when it did not. */
function withPersonHold(
  ctx: AskContext,
  raw: { state: string; detail: string },
) {
  const holds =
    ctx.dispatcher === null
      ? null
      : personPickupHolds(ctx.address.repo, ctx.dispatcher);
  const personHold = holds?.ok
    ? holds.value.find((hold) => hold.item === ctx.address.key)
    : undefined;
  const holdUnread = holds?.ok === false ? holds.failure.reason : null;
  if (holds !== null)
    ctx.reading.note({
      record: "pickup-hold",
      read: holds.ok,
      ...(holdUnread === null ? {} : { detail: holdUnread }),
    });
  const holdDetail =
    personHold === undefined ? holdUnread : pickupHoldReason(personHold);
  return {
    personHold,
    holdUnread,
    state: personHold === undefined ? raw.state : "held",
    detail: holdDetail === null ? raw.detail : `${raw.detail}; ${holdDetail}`,
  };
}

/** What a pickup waits on: the person's hold when nothing else holds it, else what the line says. */
function pickupWaitsOn(
  ctx: AskContext,
  w: {
    personHold: PersonPickupHold | undefined;
    holdUnread: string | null;
    state: string;
    needs: LineNeed[];
    holding: ReturnType<typeof holdingRecord>;
    claim: ReturnType<typeof claimHolder>;
    queued: LineQueued | undefined;
  },
) {
  if (
    w.personHold !== undefined &&
    w.needs.length === 0 &&
    w.holding === null &&
    w.claim === "none"
  )
    return personWait(
      "release the pickup hold",
      pickupHoldReason(w.personHold),
      { people: [w.personHold.by] },
    );
  return waitsOnOf(
    w.holdUnread === null ? w.state : "unknown",
    w.needs,
    ctx,
    w.holding !== null,
    w.queued,
  );
}

/** The answer for an item the tracker read. */
async function issueAnswer(
  ctx: AskContext,
  tracker: RepoTracker,
  issue: Issue,
): Promise<StationAnswer> {
  const { address, name } = ctx;
  const local = await dispatcherReads(
    ctx,
    (r) =>
      r.record.action === "pickup" &&
      (r.record.item === address.key ||
        (r.record.batchItems?.some((i) => i.key === address.key) ?? false)),
    address.key,
  );
  const member = await membershipOf(ctx, tracker);
  const needs = currentNeeds(needsOf(ctx), issue, tracker.identity, member);
  const raw = stateOf(issue, tracker.identity, needs, member);
  const { personHold, holdUnread, state, detail } = withPersonHold(ctx, raw);
  const holding = holdingRecord(local.records);
  const path = ctx.dispatcher === null ? "" : statePath(ctx.dispatcher);
  const last = lastEnded(local.rows, ["pickup"]);
  // The newest tick's overlap reason and footprint note hold only while the item still waits to be picked up.
  const queued = state === "assigned" ? queuedOf(ctx) : undefined;
  const claim = claimHolder(raw.state, issue);
  const waitsOn = pickupWaitsOn(ctx, {
    personHold,
    holdUnread,
    state,
    needs,
    holding,
    claim,
    queued,
  });
  return {
    found: true,
    title: issue.title,
    url: issue.url,
    holder: holding === null ? claim : recordHolder(holding, null),
    state,
    stateDetail: detail,
    waitsOn,
    ...(queued?.overlap === undefined ? {} : { overlap: queued.overlap }),
    ...(queued?.footprint === undefined ? {} : { footprint: queued.footprint }),
    last: last === null ? null : lastOfRow(last),
    entries: [
      ...(await assignment(ctx, tracker, issue, member)),
      ...localLaunchEntries(local.records, name, new Set(), path),
      ...logEntries(local.rows, name, path),
    ],
  };
}

/** With `--thread`: the item's assignment to the factory identity, as the tracker reports who made it. */
async function assignment(
  ctx: AskContext,
  tracker: RepoTracker,
  issue: Issue,
  member: Membership,
): Promise<ThreadEntry[]> {
  const { identity } = tracker;
  if (!ctx.thread || identity === null || !(member.assigned || member.claimed))
    return [];
  const by = await trackerRead(ctx, () =>
    openTracker(tracker.config, tracker.root).assignedBy(
      ctx.address.key,
      identity,
    ),
  );
  ctx.reading.note({
    record: "tracker-assignment",
    read: "value" in by,
    ...("why" in by ? { detail: by.why } : {}),
  });
  // An assignment the tick would not accept started nothing, so it is no request.
  if ("why" in by || !by.value.trusted) return [];
  return [
    {
      // The tracker reports who assigned the item, not when; the item's last update is not that time.
      at: "",
      kind: "request",
      from: by.value.name,
      to: ctx.name,
      text: `assigned to ${identity} (the tracker records no time for the assignment)`,
      record: {
        kind: "tracker-claim",
        ...(issue.url === null ? {} : { url: issue.url }),
      },
    },
  ];
}
