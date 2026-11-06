/** Exact dispatcher-written content, rather than a marker, authorizes retirement. */
import { withoutMarks, type Workspace } from "../runtime/port.ts";
import { stateDb } from "../state.ts";

export function ownsComment(w: Workspace, root: string): boolean {
  if (withoutMarks(w.comment) === "") return true;
  const row = stateDb(root)
    .query("SELECT comment, pending FROM notices_content WHERE workspace = ?")
    .get(w.path) as { comment: string; pending: string | null } | null;
  if (row?.pending === w.comment) {
    stateDb(root)
      .query(
        "UPDATE notices_content SET comment = pending, pending = NULL WHERE workspace = ?",
      )
      .run(w.path);
    return true;
  }
  return row?.comment === w.comment;
}

/** Persist only a dispatcher-only projection before attempting delivery. */
export function intendComment(
  workspace: Workspace,
  comment: string,
  root: string,
  repo: string,
): void {
  stateDb(root)
    .query(`INSERT INTO notices_content (workspace, comment, repo, pending) VALUES (?, '', ?, ?)
    ON CONFLICT (workspace) DO UPDATE SET pending = excluded.pending, repo = excluded.repo`)
    .run(workspace.path, repo, comment);
}

export function recordComment(
  workspace: Workspace,
  comment: string,
  root: string,
  repo: string,
): void {
  stateDb(root)
    .query(`INSERT INTO notices_content (workspace, comment, repo) VALUES (?, ?, ?)
    ON CONFLICT (workspace) DO UPDATE SET comment = excluded.comment, repo = excluded.repo, pending = NULL`)
    .run(workspace.path, comment, repo);
}

/** Drop snapshots only for workspaces no longer listed in their repository. */
export function pruneComments(
  repo: string,
  workspaces: readonly Workspace[],
  root: string,
): void {
  const db = stateDb(root);
  const keep = new Set(workspaces.map((w) => w.path));
  const rows = db
    .query(
      "SELECT workspace FROM notices_content WHERE repo = ? OR repo IS NULL",
    )
    .all(repo) as { workspace: string }[];
  const remove = db.query("DELETE FROM notices_content WHERE workspace = ?");
  for (const row of rows)
    if (!keep.has(row.workspace)) remove.run(row.workspace);
}
