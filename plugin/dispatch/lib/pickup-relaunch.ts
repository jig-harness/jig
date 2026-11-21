/**
 * A stalled pickup whose work sits in its own tree: the tick relaunches it
 * once, in that tree and never a fresh one, with a fixed prompt to push and
 * record the work (`session.ts`), rather than raising the stall to a person
 * (`dispatch.stalled_relaunch: finish-once`, the default; `never` turns it
 * off). The tick tells it from its own records and local git alone:
 *
 * - the pickup: the latest unreleased launch record of this host for the
 *   item, a headless pass of the item alone (a batch's need stays a
 *   person's), that ended or died without recording `done` (a pass that
 *   recorded `done` handed its item on, whatever its tree still holds);
 * - its tree: the workspace that record names, read with local git
 *   (`pickup-tree.ts`) for unpushed commits and uncommitted edits. A pass
 *   that died or recorded no result takes the relaunch whatever its tree
 *   holds, since recording is the part it never did;
 * - once per item and head: a relaunch record keeps the tree's head it ran
 *   at (`relaunchHead`), and a second stall at that head is a person's.
 *
 * The tree is this host's, since its launch record is. Where no open
 * workspace holds it any more, a fresh tree would not carry the work, so
 * the need stays framed for a person with the tree named. While the host's
 * health check fails (`rerun-gate.ts`), the relaunch waits for it.
 *
 * A pickup that stopped on a fault of its host (`pickup-host-fault.ts`) is
 * relaunched the same way, to resume its work: as soon as it is idle and the
 * health check passes, whatever its tree holds; its record keeps the fault,
 * which the relaunch's prompt names.
 *
 * A claimed pickup whose push the host's test lock held past its wait
 * (`pickup-lock-wait.ts`) is relaunched the same way, to push and go on,
 * as soon as it is idle; its relaunch is counted along its chain of
 * relaunches there rather than once per head, since a push that never got
 * through leaves the head where it was.
 */
import type { ReadRecord } from "./launches.ts";
import type { HostFault } from "./pickup-host-fault.ts";
import {
  type PickupTree,
  treeText,
  type TreeReader,
  unshipped,
} from "./pickup-tree.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type { Action, DispatchSection, RepoReport } from "./types.ts";

/** What the rule reads. */
export interface RelaunchInput {
  section: Pick<DispatchSection, "stalledRelaunch">;
  launches: readonly ReadRecord[];
  sessions: SessionsReport;
  /** Reads a pickup's tree; absent, no stall is relaunched. */
  trees?: TreeReader;
  /** Why the host's health check fails; `null` or absent while it passes. */
  rerunsHeld?: string | null;
  /** The host fault the pickup stopped on, when it did: relaunched to resume it, whatever its tree holds. */
  fault?: HostFault | null;
  dependency?: string;
  /** The pickup's push was refused only because its wait for the host's test lock ran out: relaunched to push and go on, whatever its tree holds and whatever relaunch its head already had. */
  lockWait?: boolean;
}

/** What the rule makes of a stalled pickup. */
export type RelaunchStep =
  /** Not this rule's case: the stall is raised as it reads. */
  | { kind: "none" }
  /** Relaunch it in its tree. */
  | { kind: "relaunch"; action: Action }
  /** Due, but held while the host's health check fails. */
  | { kind: "held"; why: string }
  /** Raised to a person, with what the rule found. */
  | { kind: "stall"; note: string };

const NONE: RelaunchStep = { kind: "none" };

/** A tree git read. */
type ReadTree = Extract<PickupTree, { kind: "read" }>;

/** Whether `latest` is a pickup this rule may relaunch: a headless pass of one item, with a tree, that ended without handing its item on. */
function relaunchable(latest: ReadRecord): boolean {
  const { record, state } = latest;
  return (
    record.action === "pickup" &&
    record.headless === true &&
    record.batchItems === undefined &&
    record.workspace !== null &&
    latest.result !== "done" &&
    (state.kind === "ended" || state.kind === "died")
  );
}

/** The relaunch of `key` already made at `head`, if any. */
function relaunchedAt(
  key: string,
  head: string,
  launches: readonly ReadRecord[],
): ReadRecord | undefined {
  return launches.find(
    (r) =>
      r.record.action === "pickup" &&
      r.record.item === key &&
      r.record.relaunchOf !== undefined &&
      r.record.relaunchHead === head,
  );
}

/** Whether the rule looks at this pickup at all: enabled (or waiting on a dependency), able to read trees and sessions, and a relaunchable latest launch. */
function ruleApplies(
  latest: ReadRecord | undefined,
  input: RelaunchInput,
): latest is ReadRecord {
  if (
    input.dependency === undefined &&
    input.section.stalledRelaunch === "never"
  )
    return false;
  return (
    input.trees !== undefined &&
    latest !== undefined &&
    relaunchable(latest) &&
    input.sessions.ok
  );
}

/** Whether nothing calls for a relaunch: the tree holds nothing unshipped, the pickup recorded its result, and no fault, lock wait or dependency asks for one. */
function nothingDue(
  tree: ReadTree,
  noResult: boolean,
  fault: HostFault | null,
  lockWait: boolean,
  input: RelaunchInput,
): boolean {
  return (
    !unshipped(tree) &&
    !noResult &&
    fault === null &&
    !lockWait &&
    input.dependency === undefined
  );
}

/** The earlier relaunch that makes another one a person's: of this record for a dependency, none for a lock wait, otherwise one at the same head. */
function earlierRelaunch(
  key: string,
  record: ReadRecord["record"],
  tree: ReadTree,
  lockWait: boolean,
  input: RelaunchInput,
): ReadRecord | undefined {
  if (input.dependency !== undefined)
    return input.launches.find((row) => row.record.relaunchOf === record.id);
  if (lockWait) return undefined;
  return relaunchedAt(key, tree.head, input.launches);
}

/** What the relaunch is told beside its tree: the fault, dependency and lock wait it resumes after. */
function relaunchExtras(
  fault: HostFault | null,
  lockWait: boolean,
  dependency: string | undefined,
): { fault?: string; dependency?: string; lockWait?: true } {
  return {
    ...(fault === null ? {} : { fault: fault.why }),
    ...(dependency === undefined ? {} : { dependency }),
    ...(lockWait ? { lockWait: true as const } : {}),
  };
}

/** The relaunch action for `item` in the open workspace `open` that holds its tree. */
function relaunchAction(
  item: { key: string; title: string; state: string },
  record: ReadRecord["record"],
  at: { open: { id: string; path: string }; path: string; tree: ReadTree },
  why: { holds: string; fault: HostFault | null; lockWait: boolean },
  dependency: string | undefined,
): Action {
  const { open, path, tree } = at;
  return {
    stage: "pickup",
    target: item.key,
    record: "runtime",
    reason:
      dependency !== undefined
        ? `pickup resumed in its original tree after waiting for ${dependency}`
        : relaunchReason(why.holds, why.fault, why.lockWait),
    evidence: {
      title: item.title,
      state: item.state,
      record: record.id,
      workspace: path,
      head: tree.head,
      unpushed: tree.unpushed,
      uncommitted: tree.uncommitted,
    },
    relaunch: {
      record: record.id,
      workspace: { id: open.id, path: open.path },
      head: tree.head,
      ...relaunchExtras(why.fault, why.lockWait, dependency),
    },
  };
}

/**
 * What the rule makes of the claimed item `item`, idle with no running
 * session, whose latest pickup is `latest`.
 */
export function relaunchStep(
  item: { key: string; title: string; state: string },
  latest: ReadRecord | undefined,
  input: RelaunchInput,
): RelaunchStep {
  if (!ruleApplies(latest, input) || !input.sessions.ok) return NONE;
  const { record } = latest;
  const path = (record.workspace as { path: string }).path;
  const open = input.sessions.workspaces.find((w) => w.path === path);
  const tree = (input.trees as TreeReader)(path);
  if (tree.kind === "unread")
    return {
      kind: "stall",
      note: `whether its launch's tree ${path} holds unshipped work could not be told: ${tree.why}`,
    };
  const noResult = latest.result === null;
  const fault = input.fault ?? null;
  const lockWait = input.lockWait === true;
  if (nothingDue(tree, noResult, fault, lockWait, input)) return NONE;
  const holds = `launch record ${record.id}'s tree ${path} holds ${treeText(tree)}${noResult ? ", and the pickup recorded no result" : ""}`;
  if (open === undefined)
    return {
      kind: "stall",
      note: `${holds}, but no open workspace on this host holds that tree: a fresh tree would not carry the work, so a person recovers it`,
    };
  const earlier = earlierRelaunch(item.key, record, tree, lockWait, input);
  if (earlier !== undefined)
    return {
      kind: "stall",
      note: `${holds}; it was relaunched once at that head (launch record ${earlier.record.id}) and stalled again, so a second relaunch is a person's`,
    };
  const held = input.rerunsHeld ?? null;
  if (held !== null)
    return {
      kind: "held",
      why: `${holds}; its relaunch waits while ${held}`,
    };
  return {
    kind: "relaunch",
    action: relaunchAction(
      item,
      record,
      { open, path, tree },
      { holds, fault, lockWait },
      input.dependency,
    ),
  };
}

/** Why the pickup is relaunched in its tree, in words. */
function relaunchReason(
  holds: string,
  fault: HostFault | null,
  lockWait: boolean,
): string {
  if (lockWait)
    return `pickup whose push the pre-push hook refused only because its wait for the host's test lock ran out: ${holds}; relaunched in that tree to push and go on once the host's validation capacity admits it (dispatch.stalled_relaunch finish-once)`;
  return fault === null
    ? `stalled pickup: ${holds}; relaunched once in that tree to push and record it (dispatch.stalled_relaunch finish-once)`
    : `pickup stopped on a fault of this host (${fault.why}), whose health check passes again: ${holds}; relaunched once in that tree to resume it (dispatch.stalled_relaunch finish-once)`;
}

/** Whether the relaunch rule settles the item for this tick: relaunched in its tree, or waiting for the host's health check. */
export function relaunched(
  step: RelaunchStep,
  key: string,
  plan: Pick<RepoReport, "actions" | "quiet">,
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

/** Relaunch records are durable recovery evidence: keep each head and source. */
export function relaunchAnchors(records: ReadRecord[]): Set<string> {
  const kept = new Set<string>();
  for (const { record } of records) {
    if (record.relaunchOf === undefined || record.relaunchHead === undefined)
      continue;
    kept.add(record.id);
    kept.add(record.relaunchOf);
  }
  return kept;
}
