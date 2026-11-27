/** Trackers distinguish an epic's configured marker from its child relationships. */
export function isEpicPickup(issue: {
  isEpic: boolean;
  hasOpenChildren: boolean;
  hasChildren?: boolean;
}): boolean {
  return issue.isEpic || issue.hasOpenChildren || issue.hasChildren === true;
}

export const EPIC_PICKUP_REASON = "epics are worked through their children";
