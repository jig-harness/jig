/** Small independent items sharing a configured change area use one pickup. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  parseWorkBatchSection,
  type WorkBatchSettings,
} from "../../skills/work-batch/scripts/lib/policy.ts";
import { parseTrackerLabels } from "../../shared/tracker-labels.ts";
import { isRecord } from "../../shared/guards.ts";
import { parseAgentRouting } from "../../skills/do-item/scripts/determine_agent.ts";
import type { Action, WantedItem } from "./types.ts";

export interface BatchItem {
  key: string;
  person: string;
  ancestor?: string;
}

/** Only launchable actions join: held, running and unreadable items never enter a batch. */
export function batchPickups(
  actions: Action[],
  wanted: WantedItem[],
  values: Record<string, unknown>,
): Action[] {
  const routing = parseAgentRouting(values);
  const policy = parseWorkBatchSection(
    values,
    parseTrackerLabels(values).batchSizes,
  );
  const groups = new Map<string, Action[]>();
  for (const action of actions) {
    if (action.stage !== "pickup") continue;
    const item = wanted.find((i) => i.key === action.target);
    const issue = item?.queueIssue;
    if (
      item?.servedPerson === undefined ||
      item.batchAllowed === false ||
      issue === undefined ||
      issue.priority === 1 ||
      !Object.hasOwn(policy.sizePoints, issue.size?.toLowerCase() ?? "")
    )
      continue;
    if (
      issue.labels.some((l) =>
        [
          "security",
          "has-migration",
          "breaking",
          "sensitive",
          ...policy.soloFlags,
        ].includes(l),
      )
    )
      continue;
    const areas = [
      ...new Set(
        issue.labels.flatMap((l) =>
          typeof routing.codeareaAreas[l.toLowerCase()] === "string"
            ? [String(routing.codeareaAreas[l.toLowerCase()])]
            : [],
        ),
      ),
    ];
    if (areas.length !== 1) continue;
    const area = areas[0];
    if (area === undefined) continue;
    const group = groups.get(area) ?? [];
    group.push(action);
    groups.set(area, group);
  }
  return groupedActions(groups, actions, wanted, policy);
}

function groupedActions(
  groups: Map<string, Action[]>,
  actions: Action[],
  wanted: WantedItem[],
  policy: WorkBatchSettings,
): Action[] {
  const removed = new Set<Action>();
  for (const group of groups.values()) {
    // The batch skill's normal upper bound; overflow stays a later independent launch.
    const members = fittingMembers(group, wanted, policy);
    if (members.length < 2) continue;
    const first = members[0];
    if (first === undefined) continue;
    const items: BatchItem[] = members.flatMap((a) => {
      const i = wanted.find((i) => i.key === a.target);
      return i?.servedPerson === undefined
        ? []
        : [
            {
              key: i.key,
              person: i.servedPerson,
              ...(i.ancestorEpic === undefined
                ? {}
                : { ancestor: i.ancestorEpic }),
            },
          ];
    });
    first.evidence.batchItems = JSON.stringify(items);
    first.reason += `; one work-batch pickup for ${items.map((i) => i.key).join(", ")}`;
    for (const action of members.slice(1)) removed.add(action);
  }
  return actions.filter((a) => !removed.has(a));
}

/** Evidence is parsed as data before it reaches a launch or shell command. */
export function batchItemsOf(
  value: unknown,
): Outcome<BatchItem[] | undefined, "invalid"> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string")
    return failed("invalid", "batch evidence is not text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return failed("invalid", "batch evidence is not JSON", error);
  }
  if (!Array.isArray(parsed))
    return failed("invalid", "batch evidence is not a list");
  const items: BatchItem[] = [];
  for (const i of parsed) {
    if (
      !isRecord(i) ||
      typeof i.key !== "string" ||
      typeof i.person !== "string" ||
      (i.ancestor !== undefined && typeof i.ancestor !== "string")
    )
      return failed("invalid", "batch member is malformed");
    items.push({
      key: i.key,
      person: i.person,
      ...(typeof i.ancestor === "string" ? { ancestor: i.ancestor } : {}),
    });
  }
  return ok(items);
}

function fittingMembers(
  group: Action[],
  wanted: WantedItem[],
  policy: WorkBatchSettings,
): Action[] {
  let points = 0;
  const members: Action[] = [];
  for (const action of group) {
    const size =
      wanted
        .find((i) => i.key === action.target)
        ?.queueIssue?.size?.toLowerCase() ?? "";
    const cost = policy.sizePoints[size];
    if (
      cost === undefined ||
      points + cost > policy.pointBudget ||
      members.length >= policy.maxItems
    )
      continue;
    points += cost;
    members.push(action);
  }
  return members;
}
