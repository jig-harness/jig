/** Exact dispatcher-written content, rather than a marker, authorizes retirement. */
import { withoutMarks, type Workspace } from "../runtime/port.ts";
import { stateDb } from "../state.ts";

export function ownsComment(w: Workspace, root: string): boolean {
  if (withoutMarks(w.comment) === "") return true;
  const row = stateDb(root)
    .query("SELECT comment FROM notices_content WHERE workspace = ?")
    .get(w.path) as { comment: string } | null;
  return row?.comment === w.comment;
}

export function recordComment(
  workspace: Workspace,
  comment: string,
  root: string,
  repo: string,
): void {
  if (workspace.branch !== "jig-dispatch-notices") return;
  stateDb(root)
    .query(`INSERT INTO notices_content (workspace, comment, repo) VALUES (?, ?, ?)
    ON CONFLICT (workspace) DO UPDATE SET comment = excluded.comment, repo = excluded.repo`)
    .run(workspace.path, comment, repo);
}

/** Only the listed repository's notices workspace needs removal authorization. */
export function pruneComments(
  repo: string,
  workspaces: readonly Workspace[],
  root: string,
): void {
  const db = stateDb(root);
  const keep = new Set(
    workspaces
      .filter((w) => w.branch === "jig-dispatch-notices")
      .map((w) => w.path),
  );
  const rows = db
    .query(
      "SELECT workspace FROM notices_content WHERE repo = ? OR repo IS NULL",
    )
    .all(repo) as { workspace: string }[];
  const remove = db.query("DELETE FROM notices_content WHERE workspace = ?");
  for (const row of rows)
    if (!keep.has(row.workspace)) remove.run(row.workspace);
}
