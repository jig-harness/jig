/**
 * The `blocked` state's writer: the tracker side of the drive-ledger
 * projection (`shared/pr-labels/blocked.ts` decides; this reads and writes
 * the tracker). The drive calls it when its ledger changes and the
 * dispatcher's tick calls it for each managed pull request, each wherever it
 * writes the pull request state labels, so the tick corrects what a drive's
 * write missed.
 *
 * Nothing is read or written when `issue_tracker.states.blocked` is unset,
 * when the ledger gives no state, or on a pull request carrying the `hold`
 * or `held` label. Each linked item is read, and written only when it
 * disagrees with what the ledger says. A block moves the item, then posts the
 * comment that carries the marker, then writes the configured fields; when
 * the comment does not post, the move is undone, so an item is never left
 * blocked without the marker that returns it. Every failure is a value in
 * the result, never a throw: the next tick tries again.
 */
import {
  type BlockedMarker,
  blockedReason,
  blockingComment,
  decideItem,
  linkedKeys,
  newestMarker,
  type ParkCause,
  returningComment,
  wantOf,
} from "../../../../shared/pr-labels/blocked.ts";
import {
  hasCommand,
  type LabelConfig,
  labelName,
  type Projected,
} from "../../../../shared/pr-labels/projection.ts";
import type { IssueKeys } from "./tracker/keys.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  type StateContext,
  trackerStateMaps,
  CLOSED_STATE_TYPES,
  type Tracker,
} from "./tracker/port.ts";

/** One pull request as the projection reads it. */
export interface BlockedPr {
  pr: number;
  url: string | null;
  /** Its description, which links the items. */
  body: string;
  labels: readonly string[];
  /** The state its ledger maps to (`ledgerState`). */
  projected: Projected;
  /** The stop the ledger records (`stopKey`). */
  stop: string;
  /** Each unanswered park's class and reason, or the stop's own where no park framed it. */
  causes: ParkCause[];
}

/** What happened to one linked item. */
export interface BlockedOutcome {
  item: string;
  outcome: "blocked" | "returned" | "kept" | "refused";
  detail: string;
}

type BlockTracker = Pick<
  Tracker,
  | "stateName"
  | "stateMaps"
  | "getIssue"
  | "issueComments"
  | "transition"
  | "postComment"
  | "writeBlockedFields"
>;

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]?.trim() || "an unknown failure";
}

/** The canonical state a tracker state name is, the first in the port's order. */
function canonicalOf(
  tracker: Pick<Tracker, "stateName">,
  name: string,
  context: StateContext,
): CanonicalState | null {
  return (
    CANONICAL_STATES.find((s) => {
      const configured = tracker.stateName(s, context);
      return configured !== null && same(configured, name);
    }) ?? null
  );
}

/** Why the projection leaves this pull request's items as they are; `null` to project them. */
export function standsAside(
  tracker: Pick<Tracker, "stateName" | "stateMaps">,
  labels: LabelConfig,
  pr: Pick<BlockedPr, "labels" | "projected">,
): string | null {
  if (trackerStateMaps(tracker).every((map) => map.blocked === null))
    return "issue_tracker.states.blocked is not set";
  if (wantOf(pr.projected) === "none") return "its ledger gives no state";
  if (hasCommand(labels, pr.labels, "hold"))
    return `it carries ${labelName(labels, "hold")}`;
  const held = labelName(labels, "held");
  return pr.labels.includes(held) ? `it carries ${held}` : null;
}

/** Project the pull request's ledger onto each item its description links. */
export async function projectBlocked(
  tracker: BlockTracker,
  keys: Pick<IssueKeys, "source" | "normalize">,
  labels: LabelConfig,
  pr: BlockedPr,
  now: () => Date = () => new Date(),
  /** Asked before each item's reads and writes: `false` when the caller's ledger is no longer the current one. */
  stillOurs: () => Promise<boolean> = async () => true,
): Promise<BlockedOutcome[]> {
  if (standsAside(tracker, labels, pr) !== null) return [];
  const want = wantOf(pr.projected);
  const items = linkedKeys(pr.body, keys.source).map(
    (k) => keys.normalize(k) ?? k,
  );
  const out: BlockedOutcome[] = [];
  for (const key of items) {
    if (!(await stillOurs())) {
      out.push({
        item: key,
        outcome: "refused",
        detail: "its drive ledger no longer belongs to this driver",
      });
      break;
    }
    out.push(await projectItem(tracker, pr, want, key, now, stillOurs));
  }
  return out;
}

async function projectItem(
  tracker: BlockTracker,
  pr: BlockedPr,
  want: ReturnType<typeof wantOf>,
  key: string,
  now: () => Date,
  stillOurs: () => Promise<boolean>,
): Promise<BlockedOutcome> {
  try {
    const issue = await tracker.getIssue(key);
    if (issue === null)
      return { item: key, outcome: "refused", detail: `${key} does not read` };
    if (tracker.stateName("blocked", issue) === null)
      return {
        item: key,
        outcome: "kept",
        detail: `${key}: blocked is absent from its workflow`,
      };
    const canonical = canonicalOf(tracker, issue.state.name, issue);
    const isBlocked = canonical === "blocked";
    // The comments are read only where a write may follow.
    if ((want === "blocked") === isBlocked)
      return {
        item: key,
        outcome: "kept",
        detail: `${key} is ${issue.state.name}`,
      };
    const comments = (await tracker.issueComments(key)).comments.filter(
      (c) => c.trusted,
    );
    const decision = decideItem({
      want,
      pr: pr.pr,
      stop: pr.stop,
      item: {
        key,
        canonical,
        stateName: issue.state.name,
        closed: (CLOSED_STATE_TYPES as readonly string[]).includes(
          issue.state.type,
        ),
      },
      marker: newestMarker(comments),
    });
    if (decision.move === "none")
      return { item: key, outcome: "kept", detail: decision.why };
    // The reads above took time: a successor may hold the ledger by now.
    if (!(await stillOurs()))
      return {
        item: key,
        outcome: "refused",
        detail: "its drive ledger no longer belongs to this driver",
      };
    if (decision.move === "block")
      return await block(
        tracker,
        pr,
        key,
        issue.state.name,
        decision.marker,
        now,
      );
    return await unblock(
      tracker,
      pr.pr,
      key,
      decision.to as CanonicalState,
      issue,
    );
  } catch (error) {
    return { item: key, outcome: "refused", detail: message(error) };
  }
}

async function block(
  tracker: BlockTracker,
  pr: BlockedPr,
  key: string,
  fromName: string,
  marker: BlockedMarker,
  now: () => Date,
): Promise<BlockedOutcome> {
  await tracker.transition(key, "blocked");
  try {
    await tracker.postComment(
      key,
      blockingComment({
        pr: pr.pr,
        prUrl: pr.url,
        causes: pr.causes,
        fromName,
        marker,
      }),
    );
  } catch (error) {
    const why = message(error);
    try {
      await tracker.transition(key, marker.from as CanonicalState);
    } catch (undo) {
      return {
        item: key,
        outcome: "refused",
        detail: `${key} moved to blocked, but its comment did not post (${why}) and the move could not be undone (${message(undo)}): a person moves it back to ${fromName}`,
      };
    }
    return {
      item: key,
      outcome: "refused",
      detail: `${key}'s blocking comment did not post, so the move was undone: ${why}`,
    };
  }
  const fields = await writeFields(tracker, key, {
    reason: blockedReason(pr.causes),
    since: now().toISOString(),
  });
  return {
    item: key,
    outcome: "blocked",
    detail: `${key} moved from ${fromName} to blocked${fields}`,
  };
}

async function unblock(
  tracker: BlockTracker,
  pr: number,
  key: string,
  to: CanonicalState,
  context: StateContext,
): Promise<BlockedOutcome> {
  const name = tracker.stateName(to, context);
  if (name === null)
    return {
      item: key,
      outcome: "refused",
      detail: `${key} left ${to}, which issue_tracker.states no longer names: a person moves it out of blocked`,
    };
  await tracker.transition(key, to);
  let commented = "";
  try {
    await tracker.postComment(key, returningComment(pr, name));
  } catch (error) {
    commented = `; its comment did not post (${message(error)})`;
  }
  const fields = await writeFields(tracker, key, null);
  return {
    item: key,
    outcome: "returned",
    detail: `${key} returned to ${name}${commented}${fields}`,
  };
}

/** Write or clear the blocked fields; what to add to the outcome's detail. */
async function writeFields(
  tracker: BlockTracker,
  key: string,
  value: Parameters<NonNullable<Tracker["writeBlockedFields"]>>[1],
): Promise<string> {
  if (tracker.writeBlockedFields === undefined) return "";
  try {
    const wrote = await tracker.writeBlockedFields(key, value);
    return wrote
      ? value === null
        ? "; its blocked fields cleared"
        : "; its blocked fields written"
      : "";
  } catch (error) {
    return `; its blocked fields were not written (${message(error)})`;
  }
}

/** One outcome as a line of a writer's output; `null` for an item left as it agrees. */
export function blockedLine(pr: number, o: BlockedOutcome): string | null {
  if (o.outcome === "kept") return null;
  return o.outcome === "refused"
    ? `PR #${pr}'s item ${o.item} could not be moved (${o.detail}); a dispatcher's next tick tries again where one runs`
    : `PR #${pr}'s item ${o.detail}`;
}
