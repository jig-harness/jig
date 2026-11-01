/**
 * The pickups the tracker wants: the items assigned to the repository's
 * factory identity (`dispatch.identity`) in a dispatch state
 * (`dispatch.states`), read through the tracker interface. Only an
 * assignment a person with write access made starts a pickup, so each item's
 * current assignment is traced to its maker (`assignedBy`); an item whose
 * assigner cannot write, or whose history cannot be read, is reported and
 * never planned.
 *
 * Beside them, the items the identity claimed (in its in-progress state),
 * which the plan watches for stalls and double claims; and the fresh read a
 * pickup's launch makes just before it starts.
 */
import type {
  CanonicalState,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { failureText } from "../text.ts";
import type {
  ClaimedItem,
  DispatchSection,
  RecordRead,
  Unplaced,
  WantedItem,
} from "../types.ts";

export interface TrackerReading {
  read: RecordRead;
  wanted: WantedItem[];
  unplaced: Unplaced[];
  /**
   * The items assigned to the identity in its in-progress state, the claims
   * to watch; `null` when they could not be read (named in `unplaced`).
   */
  claimed: ClaimedItem[] | null;
}

/** The claimed items: the claim's own assignment needs no assigner check, since nothing is started for them. */
async function readClaimed(
  tracker: Tracker,
  identity: string,
): Promise<ClaimedItem[] | Unplaced> {
  try {
    const issues = await tracker.assignedIssues(identity, ["in_progress"]);
    return issues.map((i) => ({
      key: i.identifier,
      title: i.title,
      state: i.state.name,
    }));
  } catch (error) {
    return {
      target: `items in ${tracker.stateName("in_progress")}`,
      record: "tracker",
      reason: `the items ${identity} claimed could not be read, so stalls and double claims are not checked: ${failureText(error)}`,
    };
  }
}

/** The pickups; `open` opens the tracker, and is not called when there are none to read. */
export async function readPickups(
  open: () => Tracker,
  section: DispatchSection,
): Promise<TrackerReading> {
  if (section.identity === null)
    return {
      read: {
        record: "tracker",
        source: "dispatch.identity",
        ok: true,
        detail: "no dispatch.identity: this repository has no pickups",
      },
      wanted: [],
      unplaced: [],
      claimed: [],
    };
  const identity = section.identity;
  const tracker = open();
  const source = `${tracker.adapter} ${tracker.team}`;
  let issues: Awaited<ReturnType<Tracker["assignedIssues"]>>;
  try {
    issues = await tracker.assignedIssues(
      identity,
      section.states as CanonicalState[],
    );
  } catch (error) {
    return {
      read: {
        record: "tracker",
        source,
        ok: false,
        detail: `the items assigned to ${identity} could not be read: ${failureText(error)}`,
      },
      wanted: [],
      unplaced: [],
      claimed: null,
    };
  }
  const wanted: WantedItem[] = [];
  const unplaced: Unplaced[] = [];
  for (const issue of issues) {
    let by: Awaited<ReturnType<Tracker["assignedBy"]>>;
    try {
      by = await tracker.assignedBy(issue.identifier, identity);
    } catch (error) {
      unplaced.push({
        target: issue.identifier,
        record: "tracker",
        reason: `who assigned it cannot be read: ${failureText(error)}`,
      });
      continue;
    }
    if (!by.trusted) {
      unplaced.push({
        target: issue.identifier,
        record: "tracker",
        reason: `assigned to ${identity} by ${by.name}, who cannot write to ${tracker.team}; only a person with write access starts a pickup`,
      });
      continue;
    }
    wanted.push({
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state.name,
      assignee: issue.assignee?.name ?? identity,
      assignedBy: by.name,
    });
  }
  const claimed = await readClaimed(tracker, identity);
  if (!Array.isArray(claimed)) unplaced.push(claimed);
  return {
    read: {
      record: "tracker",
      source,
      ok: true,
      detail: `${issues.length} item(s) assigned to ${identity} in ${section.states.join(", ")}${Array.isArray(claimed) ? `; ${claimed.length} in ${tracker.stateName("in_progress")}` : ""}`,
    },
    wanted,
    unplaced,
    claimed: Array.isArray(claimed) ? claimed : null,
  };
}

/**
 * The fresh read just before a pickup's launch: the item as the tracker
 * holds it while it is still assigned to the identity in a dispatch state,
 * else why not.
 */
export async function freshPickup(
  tracker: Tracker,
  section: DispatchSection,
  key: string,
): Promise<PoolIssue | string> {
  if (section.identity === null) return "dispatch.identity is no longer set";
  let issues: PoolIssue[];
  try {
    issues = await tracker.assignedIssues(
      section.identity,
      section.states as CanonicalState[],
    );
  } catch (error) {
    return `the tracker cannot be read again: ${failureText(error)}`;
  }
  const issue = issues.find((i) => i.identifier === key);
  if (issue === undefined)
    return `it is no longer assigned to ${section.identity} in ${section.states.join(", ")}`;
  // The assignment authorizes the pickup: who made it is read again, so a
  // reassignment by someone without write access, or an assigner whose access
  // ended since the plan, starts nothing.
  try {
    const by = await tracker.assignedBy(key, section.identity);
    if (!by.trusted)
      return `it is assigned to ${section.identity} by ${by.name}, who cannot write to ${tracker.team}`;
  } catch (error) {
    return `who assigned it cannot be read again: ${failureText(error)}`;
  }
  return issue;
}
