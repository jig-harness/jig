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
import type { Issue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { dispatchSection } from "../../dispatch/lib/section.ts";
import { lastEnded } from "../../dispatch/lib/log.ts";
import { readLine } from "../../dispatch/lib/line-store.ts";
import type { LineNeed } from "../../dispatch/lib/dashboard-contract.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import type { Holder, ThreadEntry, WaitsOn } from "./answer.ts";
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

/** A repository's tracker, from the configuration of its checkout at `root`. */
export interface RepoTracker {
  config: TrackerConfig;
  keys: TrackerKeyForm;
  root: string;
  /** The factory identity whose assigned items are pickups; `null` when the repository names none. */
  identity: string | null;
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
  const section = attempt("unknown-tracker", "", () =>
    dispatchSection(values.value),
  );
  return ok({
    config: config.value,
    keys: (input) => keys.normalize(input),
    root,
    identity: section.ok ? section.value.identity : null,
  });
}

const DONE_TYPES = new Set(["completed", "canceled", "duplicate"]);

/** The newest tick's needs about this item. */
function needsOf(ctx: AskContext): LineNeed[] {
  if (ctx.dispatcher === null) return [];
  const line = readLine(ctx.dispatcher);
  ctx.reading.note(
    line.ok
      ? { record: "dispatch-tick-line", read: true, local: true }
      : {
          record: "dispatch-tick-line",
          read: false,
          local: true,
          detail: line.failure.reason,
        },
  );
  if (!line.ok || line.value === null) return [];
  return line.value.needs.filter(
    (n) => n.repo === ctx.address.repo && n.item === ctx.address.key,
  );
}

function stateOf(
  issue: Issue,
  identity: string | null,
  needs: readonly LineNeed[],
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
  if (issue.state.type === "started" && issue.assignee !== null)
    return { state: "claimed", detail: `${where}, assigned to ${who}` };
  if (identity !== null && issue.assignee === identity)
    return {
      state: "assigned",
      detail: `${where}, assigned to the factory identity ${identity}`,
    };
  return { state: "not assigned", detail: `${where}, assigned to ${who}` };
}

function waitsOnOf(
  state: string,
  needs: readonly LineNeed[],
  ctx: AskContext,
): WaitsOn {
  const need = needs[0];
  if (need !== undefined)
    return { person: personAct(need.cause), why: need.reason };
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
  const { reading, address, name } = ctx;
  const found = await trackerRead(ctx, () =>
    openTracker(tracker.config, tracker.root).getIssue(address.key),
  );
  if ("why" in found) {
    reading.note({ record: "tracker-claim", read: false, detail: found.why });
    return { ...nothing("unknown", found.why), found: true };
  }
  reading.note({
    record: "tracker-claim",
    read: true,
    ...(found.value === null ? { detail: "no such item" } : {}),
  });
  if (found.value === null)
    return nothing("no such item", `the tracker has no item ${address.key}`);
  const issue = found.value;
  const needs = needsOf(ctx);
  const local = await dispatcherReads(
    ctx,
    (r) => r.record.action === "pickup" && r.record.item === address.key,
    address.key,
  );
  const { state, detail } = stateOf(issue, tracker.identity, needs);
  const holding = holdingRecord(local.records);
  const path = ctx.dispatcher === null ? "" : statePath(ctx.dispatcher);
  const last = lastEnded(local.rows, ["pickup"]);
  return {
    found: true,
    title: issue.title,
    url: issue.url,
    holder:
      holding === null
        ? claimHolder(state, issue)
        : recordHolder(holding, null),
    state,
    stateDetail: detail,
    waitsOn: holding === null ? waitsOnOf(state, needs, ctx) : "none",
    last: last === null ? null : lastOfRow(last),
    entries: [
      ...(await assignment(ctx, tracker, issue)),
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
): Promise<ThreadEntry[]> {
  const { identity } = tracker;
  if (!ctx.thread || identity === null || issue.assignee !== identity)
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
      at: issue.updatedAt ?? "",
      kind: "request",
      from: by.value.name,
      to: ctx.name,
      text: `assigned to ${identity}`,
      record: {
        kind: "tracker-claim",
        ...(issue.url === null ? {} : { url: issue.url }),
      },
    },
  ];
}
