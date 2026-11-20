/**
 * Small independent items sharing a configured change area use one pickup. A
 * size that needs a person's verdict to stay in a batch never joins one here,
 * where nobody is there to give it: that item is its own pickup.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { matchOne } from "../../shared/rule-matcher.ts";
import {
  parseWorkBatchSection,
  verdictSizes,
  type WorkBatchSettings,
} from "../../skills/work-batch/scripts/lib/policy.ts";
import { parseTrackerLabels } from "../../shared/tracker-labels.ts";
import { isRecord } from "../../shared/guards.ts";
import {
  areaOfLabel,
  parseAgentRouting,
} from "../../skills/do-item/scripts/determine_agent.ts";
import {
  parseTrackerConfig,
  facetsOf,
} from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { facetValueOf } from "../../skills/do-item/scripts/lib/tracker/facets/config.ts";
import type { Action, WantedItem } from "./types.ts";

export interface BatchItem {
  key: string;
  person: string;
  ancestor?: string;
  /** The epics the late hold check reads for the member (`WantedItem.ancestors`). */
  ancestors?: string[];
}

/** Only launchable actions join: held, running and unreadable items never enter a batch. */
export function batchPickups(
  actions: Action[],
  wanted: WantedItem[],
  values: Record<string, unknown>,
  root: string,
): Action[] {
  const routing = parseAgentRouting(values);
  const sizeOf = facetValueOf(facetsOf(parseTrackerConfig(values), root).size);
  const labels = parseTrackerLabels(values);
  const policy = parseWorkBatchSection(
    values,
    labels.batchSizes.map(sizeOf),
    sizeOf,
  );
  const ownPickup = verdictSizes(policy);
  const groups = new Map<string, Action[]>();
  for (const action of actions) {
    if (action.stage !== "pickup") continue;
    const item = wanted.find((i) => i.key === action.target);
    const issue = item?.queueIssue;
    const size = issue?.size?.toLowerCase() ?? "";
    if (
      item?.servedPerson === undefined ||
      item.batchAllowed === false ||
      issue === undefined ||
      issue.priority === 1 ||
      !Object.hasOwn(policy.sizePoints, size) ||
      ownPickup.includes(size)
    )
      continue;
    if (
      matchOne(
        "work_batch.solo_flags",
        {
          labels: [
            "security",
            "has-migration",
            "breaking",
            "sensitive",
            ...policy.soloFlags,
          ],
        },
        { labels: issue.labels },
      ) !== null
    )
      continue;
    const areas = [
      ...new Set(issue.labels.flatMap((l) => areaOfLabel(routing, l) ?? [])),
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
              ...(i.ancestors === undefined ? {} : { ancestors: i.ancestors }),
            },
          ];
    });
    first.evidence.batchItems = JSON.stringify(items);
    first.reason += `; one work-batch pickup for ${items.map((i) => i.key).join(", ")}`;
    for (const action of members.slice(1)) removed.add(action);
  }
  return actions.filter((a) => !removed.has(a));
}

/** Whether a value is a list of item keys, such as an ancestor chain. */
export function isKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** An ancestor chain carried as JSON evidence; `undefined` when absent. */
export function ancestorsOf(
  value: unknown,
): Outcome<string[] | undefined, "invalid"> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string")
    return failed("invalid", "ancestor evidence is not text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return failed("invalid", "ancestor evidence is not JSON", error);
  }
  return isKeyList(parsed)
    ? ok(parsed)
    : failed("invalid", "ancestor evidence is not a list of keys");
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
      (i.ancestor !== undefined && typeof i.ancestor !== "string") ||
      (i.ancestors !== undefined && !isKeyList(i.ancestors))
    )
      return failed("invalid", "batch member is malformed");
    items.push({
      key: i.key,
      person: i.person,
      ...(typeof i.ancestor === "string" ? { ancestor: i.ancestor } : {}),
      ...(isKeyList(i.ancestors) ? { ancestors: i.ancestors } : {}),
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
