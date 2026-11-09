/**
 * The marker labels the tick keeps beside the dispatch labels' set, on the
 * pull requests it reads. They carry no prefix and put no pull request in
 * the set's scope:
 *
 * - **Owed steps**: the repository's manual-operations label
 *   (`issue_tracker.labels.manual_ops`, `manual-ops` by default) on a pull
 *   request whose `## Out-of-tree follow-ups` section lists a step still
 *   owed (`owed-steps.ts`), open or merged. It is derived from the
 *   description at every tick, as a state label is from its ledger: added
 *   where a step is owed, removed where none is, so one a person added or
 *   removed by hand is corrected. A merged pull request keeps it until every
 *   step is checked off or its follow-up is done, which reports each step
 *   done or filed; then `followed-up` stands alone. A description that did
 *   not read leaves it as it is.
 * - **Automation**: `automation` on an open pull request a bot opened that
 *   carries no `automation:` label (`automation.ts`). The tick adds it and
 *   never removes it, nor any label of the `automation:` family.
 *
 * Nothing reads a marker to decide what to start, except that an
 * automation pull request is adopted only while it needs work (`adopt.ts`).
 */
import type { Author } from "./adopt.ts";
import {
  AUTOMATION_LABEL,
  AUTOMATION_SPEC,
  wantsAutomationLabel,
} from "./automation.ts";
import type { LabelSpec } from "./labels.ts";
import { owesSteps } from "./owed-steps.ts";

/** What the markers read of one pull request. */
export interface MarkedLabels {
  labels?: string[];
  body?: string;
  author?: Author;
}

/** The marker labels to add and remove on one pull request: `merged` with whether its follow-up is done. */
export function markerChange(
  manualOps: string,
  pr: MarkedLabels,
  merged: { followedUp: boolean } | null,
): { add: string[]; remove: string[] } {
  const labels = pr.labels ?? [];
  const add: string[] = [];
  const remove: string[] = [];
  const owes = owesSteps(pr.body);
  if (owes !== null) {
    const wanted = owes && merged?.followedUp !== true;
    const has = labels.includes(manualOps);
    if (wanted && !has) add.push(manualOps);
    if (!wanted && has) remove.push(manualOps);
  }
  if (merged === null && wantsAutomationLabel(pr)) add.push(AUTOMATION_LABEL);
  return { add, remove };
}

/** The marker labels `jig install dispatch --repo` creates beside the set. */
export function markerSet(manualOps: string): LabelSpec[] {
  return [
    {
      name: manualOps,
      color: "5319e7",
      description:
        "Owes steps a person takes outside the code: see its Out-of-tree follow-ups",
    },
    AUTOMATION_SPEC,
  ];
}
