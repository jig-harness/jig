export class PreconditionIssueError extends Error {}

/** One open issue follows the registry until all its preconditions hold. */
export interface TrackerIssue {
  id: string;
  title: string;
  body: string;
}
export type IssueContent = Pick<TrackerIssue, "title" | "body">;

/** Adapters return every open issue, or throw; partial listings are unsafe. */
export interface TrackerPort {
  listOpen(): Promise<TrackerIssue[]>;
  create(content: IssueContent): Promise<TrackerIssue>;
  update(id: string, content: IssueContent): Promise<TrackerIssue>;
  close(id: string): Promise<void>;
}

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

/** Caller serializes scheduled runs so two writers cannot both create an issue. */
export async function reconcilePreconditions(
  port: TrackerPort,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.key))
    throw new PreconditionIssueError(
      "external preconditions issue key must use letters, digits, dots, underscores or hyphens",
    );
  const marker = `<!-- jig:external-preconditions:${input.key} -->`;
  const matches = (await port.listOpen()).filter((issue) =>
    issue.body.split(/\r?\n/).includes(marker),
  );
  if (matches.length > 1)
    throw new PreconditionIssueError(
      `multiple open issues carry external preconditions key ${input.key}; reconcile duplicates manually`,
    );
  const current = matches[0];
  if (input.healthy) {
    if (!current) return { action: "unchanged" };
    await port.close(current.id);
    return { action: "closed", issue: current };
  }
  const content = { title: input.title, body: `${marker}\n\n${input.body}` };
  if (!current) return { action: "created", issue: await port.create(content) };
  if (current.title === content.title && current.body === content.body)
    return { action: "unchanged", issue: current };
  return { action: "updated", issue: await port.update(current.id, content) };
}
