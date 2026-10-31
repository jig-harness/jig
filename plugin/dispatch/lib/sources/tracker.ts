/**
 * The pickups the tracker wants: the items assigned to the repository's
 * factory identity (`dispatch.identity`) in a dispatch state
 * (`dispatch.states`), read through the tracker interface. Only an
 * assignment a person with write access made starts a pickup, so each item's
 * current assignment is traced to its maker (`assignedBy`); an item whose
 * assigner cannot write, or whose history cannot be read, is reported and
 * never planned.
 */
import type {
  CanonicalState,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { failureText } from "../text.ts";
import type {
  DispatchSection,
  RecordRead,
  Unplaced,
  WantedItem,
} from "../types.ts";

export interface TrackerReading {
  read: RecordRead;
  wanted: WantedItem[];
  unplaced: Unplaced[];
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
  return {
    read: {
      record: "tracker",
      source,
      ok: true,
      detail: `${issues.length} item(s) assigned to ${identity} in ${section.states.join(", ")}`,
    },
    wanted,
    unplaced,
  };
}
