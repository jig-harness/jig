/**
 * A stalled pickup whose work sits in its own tree: the tick relaunches it
 * once, in that tree and never a fresh one, with a fixed prompt to push and
 * record the work (`session.ts`), rather than raising the stall to a person
 * (`dispatch.stalled_relaunch: finish-once`, the default; `never` turns it
 * off). The tick tells it from its own records and local git alone:
 *
 * - the pickup: the latest unreleased launch record of this host for the
 *   item, a headless pass of the item alone (a batch's need stays a
 *   person's), that ended or died;
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
 */
import type { ReadRecord } from "./launches.ts";
import { treeText, type TreeReader, unshipped } from "./pickup-tree.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type { Action, DispatchSection } from "./types.ts";

/** What the rule reads. */
export interface RelaunchInput {
  section: Pick<DispatchSection, "stalledRelaunch">;
  launches: readonly ReadRecord[];
  sessions: SessionsReport;
  /** Reads a pickup's tree; absent, no stall is relaunched. */
  trees?: TreeReader;
  /** Why the host's health check fails; `null` or absent while it passes. */
  rerunsHeld?: string | null;
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

/** Whether `latest` is a pickup this rule may relaunch: a headless pass of one item, with a tree, that ended. */
function relaunchable(latest: ReadRecord): boolean {
  const { record, state } = latest;
  return (
    record.action === "pickup" &&
    record.headless === true &&
    record.batchItems === undefined &&
    record.workspace !== null &&
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

/**
 * What the rule makes of the claimed item `item`, idle with no running
 * session, whose latest pickup is `latest`.
 */
export function relaunchStep(
  item: { key: string; title: string; state: string },
  latest: ReadRecord | undefined,
  input: RelaunchInput,
): RelaunchStep {
  if (
    input.section.stalledRelaunch === "never" ||
    input.trees === undefined ||
    latest === undefined ||
    !relaunchable(latest) ||
    !input.sessions.ok
  )
    return NONE;
  const { record } = latest;
  const path = (record.workspace as { path: string }).path;
  const open = input.sessions.workspaces.find((w) => w.path === path);
  const tree = input.trees(path);
  if (tree.kind === "unread")
    return open === undefined
      ? NONE
      : {
          kind: "stall",
          note: `whether its launch's tree ${path} holds unshipped work could not be told: ${tree.why}`,
        };
  const noResult = latest.result === null;
  if (!unshipped(tree) && !noResult) return NONE;
  const holds = `launch record ${record.id}'s tree ${path} holds ${treeText(tree)}${noResult ? ", and the pickup recorded no result" : ""}`;
  if (open === undefined)
    return {
      kind: "stall",
      note: `${holds}, but no open workspace on this host holds that tree: a fresh tree would not carry the work, so a person recovers it`,
    };
  const earlier = relaunchedAt(item.key, tree.head, input.launches);
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
    action: {
      stage: "pickup",
      target: item.key,
      record: "runtime",
      reason: `stalled pickup: ${holds}; relaunched once in that tree to push and record it (dispatch.stalled_relaunch finish-once)`,
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
      },
    },
  };
}
