/** Read one launch without creating or migrating dispatcher state. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { isLaunchRecord, type LaunchRecord } from "./launches.ts";
import { readOnlyStateDb } from "./state.ts";

export function readLaunch(
  id: string,
  root?: string,
): Outcome<LaunchRecord | null> {
  const opened = readOnlyStateDb(root);
  if (!opened.ok) return opened;
  if (opened.value === null) return ok(null);
  const { db } = opened.value;
  try {
    const row = db
      .query<{ record: string }, [string]>(
        "SELECT record FROM launches WHERE id = ?",
      )
      .get(id);
    if (row === null) return ok(null);
    const record: unknown = JSON.parse(row.record);
    return isLaunchRecord(record) && record.id === id
      ? ok(record)
      : failed("launch-unreadable", "the dispatch launch record is invalid");
  } catch (error) {
    return failed(
      "launch-unreadable",
      "the dispatch launch record could not be read",
      error,
    );
  } finally {
    db.close();
  }
}
