/**
 * The eligibility check's input: issues in the tracker interface's pool form
 * (`PoolIssue`), as a JSON array a reader wrote, each field checked.
 */
import { isRecord } from "../../../../shared/guards.ts";
import {
  type EpicRecognition,
  isEpic,
} from "../../../../shared/tracker-labels.ts";
import type { PoolIssue } from "../../../do-item/scripts/lib/tracker/port.ts";
import { Refusal } from "./errors.ts";

const isText = (v: unknown): v is string => typeof v === "string";
const isTextList = (v: unknown) => Array.isArray(v) && v.every(isText);
const hasTexts = (v: unknown, keys: readonly string[]) =>
  isRecord(v) && keys.every((k) => isText(v[k]));

/** Each field of the pool form, with what it must be. Every one is required. */
const POOL_FIELDS: ReadonlyArray<
  readonly [field: string, ok: (v: unknown) => boolean, must: string]
> = [
  ["identifier", isText, "a string"],
  ["title", isText, "a string"],
  ["url", (v) => v === null || isText(v), "a string or null"],
  [
    "priority",
    (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4,
    "an integer from 0 to 4",
  ],
  [
    "createdAt",
    (v) => isText(v) && !Number.isNaN(Date.parse(v)),
    "a timestamp",
  ],
  ["state", (v) => hasTexts(v, ["id", "name", "type"]), "{ id, name, type }"],
  [
    "assignee",
    (v) => v === null || hasTexts(v, ["id", "name"]),
    "{ id, name } or null",
  ],
  ["labels", isTextList, "a list of strings"],
  ["hasOpenChildren", (v) => typeof v === "boolean", "true or false"],
  // An omitted list would read as a complete one.
  ["truncated", isTextList, "a list of strings"],
];

/** What the first malformed field of an issue must be, or `null`. */
function fieldProblem(issue: Record<string, unknown>): string | null {
  const bad = POOL_FIELDS.find(([field, ok]) => !ok(issue[field]));
  return bad === undefined ? null : `${bad[0]} must be ${bad[2]}`;
}

/**
 * Issues in the tracker interface's pool form (`PoolIssue`), as a JSON array.
 * Every field is required: a reader that omitted `truncated` or
 * `hasOpenChildren` must not have its issues read as complete and childless.
 */
export function parsePoolIssues(
  raw: unknown,
  epic: EpicRecognition,
): PoolIssue[] {
  if (!Array.isArray(raw))
    throw new Refusal("input must be a JSON array of issues");
  return raw.map((issue, i) => {
    if (!isRecord(issue)) throw new Refusal(`issue ${i + 1} must be an object`);
    const problem = fieldProblem(issue);
    if (problem !== null)
      throw new Refusal(
        `issue ${i + 1}${typeof issue.identifier === "string" ? ` (${issue.identifier})` : ""}: ${problem}`,
      );
    return {
      identifier: issue.identifier as string,
      title: issue.title as string,
      url: issue.url as string | null,
      priority: issue.priority as number,
      createdAt: issue.createdAt as string,
      state: issue.state as PoolIssue["state"],
      assignee: issue.assignee as PoolIssue["assignee"],
      labels: issue.labels as string[],
      // A reader of an earlier release wrote no `isEpic`: its labels and
      // issue type say.
      isEpic:
        typeof issue.isEpic === "boolean"
          ? issue.isEpic
          : isEpic(
              {
                labels: issue.labels as string[],
                nativeType: isText(issue.nativeType) ? issue.nativeType : null,
              },
              epic,
            ),
      hasOpenChildren: issue.hasOpenChildren as boolean,
      truncated: issue.truncated as string[],
      // A reader of an earlier release wrote no facets: none of either.
      type: typeof issue.type === "string" ? issue.type : null,
      size: typeof issue.size === "string" ? issue.size : null,
    };
  });
}
