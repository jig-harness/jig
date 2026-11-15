/**
 * A drive's per-round pass session ids, on its launch record: the `sessions`
 * column of the `launches` table, a JSON list of `{round, session, at}`, one
 * entry per pass in the order the passes started. A run is found in its
 * vendor's transcripts by its session id (design/dispatched-sessions.md §
 * How long transcripts are kept): `drive.ts` gives each Claude Code pass its
 * own (`--session-id`, minted for quota attribution) and, when the dispatcher
 * runs it, records it here as the pass starts, so a drive that dies still
 * leaves its passes findable. A pass that runs again on the same round (a
 * deadline restart) adds an entry of its own. A Codex pass takes no session
 * id and prints none the drive reads, so it adds none.
 *
 * The driver is the column's one writer. It writes only on a record that is
 * a drive's launch of the same pull request, so a drive armed by hand inside
 * another dispatched session, which inherits that session's `JIG_LAUNCH`,
 * never writes on that session's record.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { currentIso } from "../../shared/time.ts";
import { stateRoot } from "../receipts.ts";
import { existingStateDb, inTransaction } from "./state.ts";

/** One pass's session, as the launch record keeps it. */
export interface RoundSession {
  round: number;
  session: string;
  /** When the pass started. */
  at: string;
}

/** The most entries a record keeps; the oldest go first past it. */
export const ROUND_SESSIONS_MAX = 100;

/** A vendor's session id as a pass is given one: no space, no control character. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRoundSession(value: unknown): value is RoundSession {
  return (
    isMapping(value) &&
    Number.isSafeInteger(value.round) &&
    typeof value.session === "string" &&
    typeof value.at === "string"
  );
}

/** A record's sessions as the column keeps them; none when it holds none, or they do not read. */
export function readRoundSessions(
  json: string | null | undefined,
): RoundSession[] {
  if (json == null) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    swallow(error, "a launch record's round sessions do not read");
    return [];
  }
  return Array.isArray(value) ? value.filter(isRoundSession) : [];
}

/** Whether a launch record's JSON is a drive's launch of pull request `pr`. */
function drivesPr(recordJson: string, pr: number): boolean {
  let value: unknown;
  try {
    value = JSON.parse(recordJson);
  } catch (error) {
    swallow(error, "a launch record does not read");
    return false;
  }
  return (
    isMapping(value) &&
    (value.action === "rearm" || value.action === "takeover") &&
    value.pr === pr
  );
}

/**
 * Add round `round`'s pass session `session` to record `id`, a drive's
 * launch of pull request `pr`; false when nothing was written: no state
 * database, no such record, a record that is not that drive's, or a session
 * id that is not one.
 */
export function recordRoundSession(
  id: string,
  pr: number,
  round: number,
  session: string,
  root = stateRoot(),
  at = currentIso(),
): boolean {
  if (!SESSION_ID.test(session) || !Number.isSafeInteger(round)) return false;
  const db = existingStateDb(root);
  if (db === null) return false;
  return inTransaction(db, () => {
    const row = db
      .query("SELECT record, sessions FROM launches WHERE id = ?")
      .get(id) as { record: string; sessions: string | null } | null;
    if (row === null || !drivesPr(row.record, pr)) return false;
    const sessions = [
      ...readRoundSessions(row.sessions),
      { round, session, at },
    ].slice(-ROUND_SESSIONS_MAX);
    db.query("UPDATE launches SET sessions = ? WHERE id = ?").run(
      JSON.stringify(sessions),
      id,
    );
    return true;
  });
}
