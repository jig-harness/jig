/**
 * `assign`: the item assigned to the repository's factory identity
 * (`dispatch.identity`) in a dispatch state (`dispatch.states`), through the
 * tracker interface (`dispatch/lib/requests.ts`). The dispatcher's tick
 * starts a pick-up for it, and only when the person who made the
 * assignment can write to the repository: `send` adds no authority, it
 * writes as the user the tracker's credential acts as here.
 *
 * The identity, the states and the tracker are the ones the tick reads: the
 * configuration file the repository's default branch holds on the forge,
 * never the checkout's, so an unmerged edit cannot send the assignment
 * where, or in a state, the tick will not look.
 *
 * Checked before the write: the repository names a factory identity, and
 * the item is open, assigned to nobody (the identity included) and not in a
 * state of work in progress.
 *
 * On a tracker whose history leaves out changes made just after an issue's
 * creation (`assignment-window.ts`), an assignment written then is one the
 * dispatcher never sees: the send waits until the window has passed and
 * then writes. An item already assigned to the identity whose history
 * holds no assignment of it is refused with the remedy, unassign it and
 * send again: the send never changes an existing assignment.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { within } from "../../ask/lib/reading.ts";
import { assignPickup } from "../../dispatch/lib/requests.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import { issueKeysOf } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { AssignerUnknown } from "../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";
import {
  assignableFromMs,
  waitBeforeAssigning,
  windowWords,
} from "../../skills/do-item/scripts/lib/tracker/assignment-window.ts";
import type {
  CanonicalState,
  Issue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { type RepoTracker, readPickup } from "../../ask/lib/pickup.ts";
import { readTrackerConfig } from "./answer-tracker.ts";
import { formatAddress } from "../../shared/address.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import {
  NEXT_TICK,
  type Planned,
  refused,
  type TickReader,
  trackerWriter,
} from "./plan.ts";

/** The tick reading an assignment, under the pickup stage. */
const TICK: TickReader = {
  stage: "pickup",
  reader: (tick) =>
    `${tick} where its dispatch file enables the pickup stage, which starts the pick-up once it finds that the person who made the assignment can write to the repository`,
};

/** What the tick reads from the repository's default branch: its tracker, factory identity and dispatch states. */
async function tickSettings(
  ctx: AskContext,
  root: string,
): Promise<
  Outcome<{ tracked: RepoTracker; identity: string; key: string }, "refused">
> {
  const { repo } = ctx.address;
  const read = await readTrackerConfig(ctx, "the factory identity of");
  if (!read.ok) return read;
  const { where, config, section } = read.value;
  const { identity } = section;
  if (identity === null)
    return refused(
      `assign writes the item assigned to the factory identity, and ${repo} names none: set dispatch.identity in ${OVERLAY_RELPATH}`,
    );
  const keys = issueKeysOf(config);
  const key = keys?.normalize(ctx.address.key) ?? null;
  if (keys === null || key === null)
    return refused(
      `${ctx.address.key} is not an item key of the tracker ${where} names${keys === null ? "" : `, whose keys look like ${keys.example}`}`,
    );
  return ok({
    tracked: {
      root,
      config,
      keys: (input) => keys.normalize(input),
      identity,
      states: section.states,
    },
    identity,
    key,
  });
}

/**
 * Why an item assigned to `identity` cannot be started although it is
 * assigned: its history, which leaves out changes made just after the
 * issue's creation, holds no assignment of the identity. `null` when the
 * tracker has no such window, the history shows the assignment, or the
 * item is not assigned to the identity; the refusals that follow say why.
 */
export async function unseenAssignment(
  tracker: Tracker,
  key: string,
  identity: string,
  sec: number,
): Promise<string | null> {
  const window = windowWords(tracker);
  if (window === null) return null;
  try {
    await within(sec, (signal) => tracker.assignedBy(key, identity, signal));
    return null;
  } catch (error) {
    if (!(error instanceof AssignerUnknown)) return null;
    return `${key} is assigned to ${identity}, but who made that assignment cannot be read (${error.message}), so the dispatcher will not start it; ${window}. The send does not change an existing assignment: unassign ${key} on the tracker, then send this again, and it writes the assignment once the issue is past that window`;
  }
}

/**
 * When the assignment may be written: the time the tracker's creation
 * window passes for the item, or `null` when the tracker has none.
 */
export async function assignableFrom(
  tracker: Tracker,
  key: string,
  sec: number,
): Promise<Outcome<number | null, "refused">> {
  if (windowWords(tracker) === null) return ok(null);
  let createdAt: string | undefined;
  try {
    const read = await within(sec, (signal) => tracker.poolIssue(key, signal));
    createdAt = read?.value?.createdAt;
  } catch (error) {
    return refused(
      `${key}'s creation time did not read (${error instanceof Error ? error.message : String(error)}), so when its history starts recording an assignment is not known; send again`,
    );
  }
  const from = assignableFromMs(tracker, createdAt);
  return from.ok ? from : refused(`${key}: ${from.failure.reason}; send again`);
}

/** Wait out the tracker's creation window, then write the assignment (and the move). */
export async function writeAfterWindow(
  tracker: Parameters<typeof assignPickup>[0],
  item: {
    key: string;
    identity: string;
    move: CanonicalState | null;
    moveFor: Parameters<typeof assignPickup>[4];
    from: number | null;
  },
  clock: Pick<Clock, "now" | "sleep">,
): ReturnType<typeof assignPickup> {
  const { waitMs } = waitBeforeAssigning(item.from, clock.now());
  if (waitMs > 0) await clock.sleep(waitMs);
  return assignPickup(
    tracker,
    item.key,
    item.identity,
    item.move,
    item.moveFor,
  );
}

/** The plan of an assignment, or why the item cannot take it. */
export async function planAssign(
  written: AskContext,
  root: string,
  as: string | undefined,
  clock: Pick<Clock, "now" | "sleep"> = systemClock,
): Promise<Planned> {
  const { repo } = written.address;
  const settings = await tickSettings(written, root);
  if (!settings.ok) return settings;
  const { tracked, identity, key } = settings.value;
  const address = { ...written.address, key };
  const ctx: AskContext = { ...written, address, name: formatAddress(address) };
  const tracker = openTracker(tracked.config, tracked.root);
  const writer = await trackerWriter(tracker, ctx.reading.sourceSec(), as);
  if (!writer.ok) return writer;
  const login = writer.value.login;
  const { answer, issue } = await readPickup(ctx, tracked);
  if (!answer.found || issue === null) return refused(answer.stateDetail);
  const sec = ctx.reading.sourceSec();
  if (issue.assignee !== null) {
    const unseen = await unseenAssignment(tracker, key, identity, sec);
    if (unseen !== null) return refused(unseen);
  }
  if (answer.state !== "not assigned")
    return refused(
      `${key} is ${answer.state} (${answer.stateDetail}): assign writes an item nobody holds yet`,
    );
  if (issue.assignee !== null)
    return refused(
      `${key} is assigned to ${issue.assignee}; assigning it to ${identity} would take it from them, so unassign it first if that is meant`,
    );
  const states = tracked.states as CanonicalState[];
  const moveFor = (
    stateName: string,
    current: Issue = issue,
  ): CanonicalState | null =>
    states.some((state) => tracker.stateName(state, current) === stateName)
      ? null
      : (states.find((state) => tracker.stateName(state, current) !== null) ??
        states[0] ??
        null);
  if (!states.some((state) => tracker.stateName(state, issue) !== null))
    return refused(
      `${key}'s workflow has no configured dispatch state, so it cannot be assigned to ${identity}`,
    );
  if (issue.state.type === "started")
    return refused(
      `${key} is ${issue.state.name}, a state of work in progress; assign does not move it back to a dispatch state`,
    );
  const move = moveFor(issue.state.name);
  const from = await assignableFrom(tracker, key, sec);
  if (!from.ok) return from;
  const { until } = waitBeforeAssigning(from.value, clock.now());
  return ok({
    address: ctx.name,
    repo,
    verb: "assign",
    writesAs: `${login}, the user the tracker's credential acts as here`,
    record: `${key} assigned to ${identity}${
      move === null
        ? `, in ${issue.state.name}, a dispatch state`
        : `, and moved from ${issue.state.name} to ${tracker.stateName(move, issue)}, a dispatch state`
    }`,
    where: issue.url ?? key,
    reader: TICK.reader(NEXT_TICK),
    tick: TICK,
    undo: `assign ${key} to nobody on the tracker before the tick starts the pick-up`,
    notice:
      until === null
        ? null
        : `${windowWords(tracker)}: the send waits until ${until}, then writes the assignment`,
    write: async () => {
      const wrote = await writeAfterWindow(
        tracker,
        { key, identity, move, moveFor, from: from.value },
        clock,
      );
      return wrote.ok ? ok(issue.url ?? key) : wrote;
    },
  });
}
