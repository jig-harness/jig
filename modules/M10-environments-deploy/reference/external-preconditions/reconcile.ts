import { withDeadline } from "./deadline.ts";

export class PreconditionIssueError extends Error {}

/** One open issue follows the registry until all its preconditions hold. */
export interface TrackerIssue {
  id: string;
  title: string;
  body: string;
}
export type IssueContent = Pick<TrackerIssue, "title" | "body">;

/**
 * Adapters return every open issue, or throw; partial listings are unsafe.
 * `signal` aborts at the operation deadline, after which the reconciler stops
 * waiting and fails.
 */
export interface TrackerPort {
  listOpen(signal?: AbortSignal): Promise<TrackerIssue[]>;
  create(content: IssueContent, signal?: AbortSignal): Promise<TrackerIssue>;
  update(
    id: string,
    content: IssueContent,
    signal?: AbortSignal,
  ): Promise<TrackerIssue>;
  close(id: string, signal?: AbortSignal): Promise<void>;
}

/** The default bound on one tracker operation, a multi-page listing included. */
export const TRACKER_DEADLINE_MS = 120_000;

export interface ReconcileInput extends IssueContent {
  /** Stable identity for one registry within this tracker's scope. */
  key: string;
  /** True only after a complete report has no failed, unknown or pending checks. */
  healthy: boolean;
}
export interface ReconcileResult {
  action: "created" | "updated" | "closed" | "unchanged";
  issue?: TrackerIssue;
}

/**
 * Caller serializes scheduled runs so two writers cannot both create an issue.
 * Each tracker operation is bounded; one that does not finish fails the
 * reconciliation rather than stalling it.
 */
export async function reconcilePreconditions(
  port: TrackerPort,
  input: ReconcileInput,
  deadlineMs = TRACKER_DEADLINE_MS,
): Promise<ReconcileResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.key))
    throw new PreconditionIssueError(
      "external preconditions issue key must use letters, digits, dots, underscores or hyphens",
    );
  const bounded = <T>(
    what: string,
    work: (signal: AbortSignal) => Promise<T>,
  ) =>
    withDeadline(
      deadlineMs,
      `tracker ${what}`,
      work,
      (message) => new PreconditionIssueError(message),
    );
  const marker = `<!-- jig:external-preconditions:${input.key} -->`;
  const matches = (
    await bounded("listing", (signal) => port.listOpen(signal))
  ).filter((issue) => issue.body.split(/\r?\n/).includes(marker));
  if (matches.length > 1)
    throw new PreconditionIssueError(
      `multiple open issues carry external preconditions key ${input.key}; reconcile duplicates manually`,
    );
  const current = matches[0];
  if (input.healthy) {
    if (!current) return { action: "unchanged" };
    await bounded("close", (signal) => port.close(current.id, signal));
    return { action: "closed", issue: current };
  }
  const content = { title: input.title, body: `${marker}\n\n${input.body}` };
  if (!current)
    return {
      action: "created",
      issue: await bounded("create", (signal) => port.create(content, signal)),
    };
  if (current.title === content.title && current.body === content.body)
    return { action: "unchanged", issue: current };
  return {
    action: "updated",
    issue: await bounded("update", (signal) =>
      port.update(current.id, content, signal),
    ),
  };
}
