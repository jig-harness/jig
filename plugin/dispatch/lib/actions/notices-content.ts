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
  path: string,
  comment: string,
  root: string,
): void {
  stateDb(root)
    .query(`INSERT INTO notices_content (workspace, comment) VALUES (?, ?)
    ON CONFLICT (workspace) DO UPDATE SET comment = excluded.comment`)
    .run(path, comment);
}
