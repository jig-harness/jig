/**
 * The tracker port's answers, as `reconcile_parent_status.ts` reads them:
 * the parent issue and each of its children as `get_issue.ts` prints them
 * or the port's `getIssue` returns them, on any adapter. Whichever way the
 * caller read them (the scripts, or a harness's own integration whose
 * answers it put in this shape), they become one `ReconcileInput`, and every
 * gap fails the listing closed:
 *
 * - no parent, or an answer for another issue: the listing failed;
 * - a child listing not read to its end (`complete` not `true`), a parent
 *   without a labels list (a missing `manual-ops` would read as absent), or a
 *   child whose answer is missing, is for another key, or has an unreadable
 *   state: the listing is truncated. Where the parent's answer lists its
 *   children, the answers must name exactly those keys.
 */

import { isRecord } from "../../../../shared/guards.ts";
import type {
  LabelLike,
  ReconcileChildInput,
  ReconcileInput,
} from "../reconcile_parent_status.ts";
import { LINKED_PR_STATES, type LinkedPrState } from "./linked-pr.ts";

/** One issue as the tracker port answers it; only these fields are read. */
export interface IssueAnswer {
  /** `get_issue.ts`'s: `false` when the read failed. */
  found?: boolean;
  identifier?: string;
  state?: { name?: string; type?: string };
  labels?: LabelLike[];
  /** The parent's own children, as `get_issue.ts` prints them: the keys the listing must answer for. */
  children?: Array<{ identifier?: string }>;
  nativeType?: string | null;
  /** A child's linked pull request, set by the caller (`linked-pr.ts`). */
  pullRequest?: LinkedPrState;
}

/** The parent, each child by the key its listing gave, and whether that listing was read to its end. */
export interface AnswersInput {
  issue: string;
  parent: IssueAnswer | null;
  children: Record<string, IssueAnswer | null>;
  complete: boolean;
}

/** Whether `value` is the answers form rather than a `ReconcileInput`. */
export function isAnswersInput(value: unknown): value is AnswersInput {
  return (
    isRecord(value) &&
    typeof value.issue === "string" &&
    "parent" in value &&
    (value.parent === null || isRecord(value.parent)) &&
    isRecord(value.children) &&
    Object.values(value.children).every((c) => c === null || isRecord(c)) &&
    typeof value.complete === "boolean"
  );
}

const TRUNCATED: ReconcileInput = {
  found: true,
  truncated: true,
  parentLabels: [],
  children: [],
};

/** A state the reconciler can read: `get_issue.ts`'s unreadable marker, or no name and no category, is not. */
function readableState(state: unknown): { name: string; type: string } | null {
  if (!isRecord(state)) return null;
  // A field that is present with the wrong type is malformed, not absent.
  if (state.name !== undefined && typeof state.name !== "string") return null;
  if (state.type !== undefined && typeof state.type !== "string") return null;
  const name = state.name ?? "";
  const type = state.type ?? "";
  if (name.trim() === "" && type === "") return null;
  if (type === "unknown" && (name === "Unknown" || name.trim() === ""))
    return null;
  return { name, type };
}

const labelsOf = (v: unknown): LabelLike[] | null =>
  Array.isArray(v) &&
  v.every(
    (l) => typeof l === "string" || (isRecord(l) && typeof l.name === "string"),
  )
    ? (v as LabelLike[])
    : null;

function childOf(
  key: string,
  answer: IssueAnswer | null,
): ReconcileChildInput | null {
  if (answer === null || answer.found === false || answer.identifier !== key)
    return null;
  const state = readableState(answer.state);
  if (state === null) return null;
  const labels = labelsOf(answer.labels);
  const pr = answer.pullRequest;
  return {
    state,
    ...(labels === null ? {} : { labels }),
    nativeType:
      typeof answer.nativeType === "string" ? answer.nativeType : null,
    ...(pr !== undefined && (LINKED_PR_STATES as readonly string[]).includes(pr)
      ? { pullRequest: pr }
      : {}),
  };
}

/** The reconciler's input from the tracker port's answers. */
export function listingFromAnswers(input: AnswersInput): ReconcileInput {
  const { parent } = input;
  if (
    parent === null ||
    parent.found === false ||
    parent.identifier !== input.issue
  )
    return { found: false, parentLabels: [], children: [] };
  const parentLabels = labelsOf(parent.labels);
  if (!input.complete || parentLabels === null) return TRUNCATED;
  // Answers for exactly the children the parent lists: an omitted child
  // would read as done, and an extra one is another issue's.
  // A listing that is present but not an array is unreadable, not omitted.
  if (parent.children !== undefined && !Array.isArray(parent.children))
    return TRUNCATED;
  if (Array.isArray(parent.children)) {
    const expected = new Set(
      parent.children.map((c) =>
        isRecord(c) && typeof c.identifier === "string" ? c.identifier : null,
      ),
    );
    const given = Object.keys(input.children);
    if (
      expected.has(null) ||
      given.length !== expected.size ||
      given.some((k) => !expected.has(k))
    )
      return TRUNCATED;
  }
  const children = Object.entries(input.children).map(([key, answer]) =>
    childOf(key, answer),
  );
  if (children.some((c) => c === null)) return TRUNCATED;
  return {
    found: true,
    parentLabels,
    parentNativeType:
      typeof parent.nativeType === "string" ? parent.nativeType : null,
    children: children as ReconcileChildInput[],
  };
}
