/**
 * A need's life in the outcome log: one `need-opened` row when a need first
 * appears on the line the tick writes, and one `need-closed` row once it has
 * left. The rows are written in the tick's transaction whatever its notify
 * stage did, so a host that never notifies still counts what opened and what
 * closed, and how long each stayed.
 *
 * A need absent from one tick's line stays open: a read that failed, or a
 * forge that did not answer, drops its needs from a single line and brings
 * them back on the next, and that is no close and no second open. A need is
 * closed when it is absent from two ticks' lines in a row, and its close row
 * is timed at the first of them. The table `need_open` holds the needs the log
 * has open and, for each, when it was first absent. A group of releases whose
 * target moved on but still lists an item it did before is the same need
 * (`continues`).
 *
 * The row's `reason` is the need's cause and the tick's words for it when it
 * opens; when it closes, how it left, as the leave row the same tick wrote
 * (`need-leaves.ts`) says it, else that the line no longer holds it. A close
 * row's `durationMs` is how long the need was open. Both are events of the
 * outcome log (`log.ts`) with no outcome class.
 */
import type { Database } from "bun:sqlite";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { LineNeed } from "./dashboard-contract.ts";
import { insertRow } from "./log.ts";
import { continues, type NeedIdentity } from "./need-leaves.ts";

/** The longest a row's reason is kept. */
const REASON_LIMIT = 300;

interface OpenNeed extends NeedIdentity {
  openedKey: string;
  openedAt: string;
  absentAt: string | null;
}

/** What a close row says when no leave row accounts for the need. */
const NO_LEAVE = "the line no longer holds it";

const clip = (text: string): string =>
  text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`;

function readOpen(db: Database): OpenNeed[] {
  return (
    db
      .query(
        "SELECT repo, target, cause, covers, opened_key AS openedKey, opened_at AS openedAt, absent_at AS absentAt FROM need_open ORDER BY rowid",
      )
      .all() as Array<
      Omit<OpenNeed, "covers" | "cause"> & { cause: string; covers: string }
    >
  ).map((r) => ({
    ...r,
    cause: r.cause as LineNeed["cause"],
    covers: coversOf(r.covers),
  }));
}

function coversOf(text: string): string[] {
  try {
    const found: unknown = JSON.parse(text);
    return Array.isArray(found)
      ? found.filter((c): c is string => typeof c === "string")
      : [];
  } catch (error) {
    swallow(error, "a need's covers do not read as JSON; it covers nothing");
    return [];
  }
}

/** How the need left, from the leave row the tick wrote for it, else that the line no longer holds it. */
function howClosed(db: Database, need: OpenNeed): string {
  const row = db
    .query(
      "SELECT value FROM need_leaves WHERE repo = ? AND target = ? AND cause = ? AND at_ms >= ? ORDER BY at_ms DESC, id DESC LIMIT 1",
    )
    .get(need.repo, need.target, need.cause, parseMs(need.openedAt)) as {
    value: string;
  } | null;
  if (row === null) return NO_LEAVE;
  try {
    const leave: unknown = JSON.parse(row.value);
    if (!isMapping(leave) || typeof leave.how !== "string") return NO_LEAVE;
    return clip(
      `${typeof leave.by === "string" ? `${leave.by}: ` : ""}${leave.how}`,
    );
  } catch (error) {
    swallow(error, "a leave row that does not read gives no account of it");
    return NO_LEAVE;
  }
}

function eventRow(
  event: "need-opened" | "need-closed",
  key: string,
  at: string,
  need: NeedIdentity,
  reason: string,
  durationMs?: number,
) {
  return {
    kind: "event" as const,
    key,
    at,
    repo: need.repo,
    stage: "line",
    target: need.target,
    event,
    account: null,
    class: null,
    reason,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

const INSERT_OPEN =
  "INSERT OR REPLACE INTO need_open (repo, target, cause, covers, opened_key, opened_at, absent_at) VALUES (?, ?, ?, ?, ?, ?, NULL)";

const dropOpen = (db: Database, need: NeedIdentity): void => {
  db.query(
    "DELETE FROM need_open WHERE repo = ? AND target = ? AND cause = ?",
  ).run(need.repo, need.target, need.cause);
};

/** A held need the line still holds: back in, or moved on to another target within a group, it is open and not absent. */
function keepOpen(db: Database, open: OpenNeed, present: LineNeed): void {
  if (open.absentAt === null && present.target === open.target) return;
  dropOpen(db, open);
  db.query(INSERT_OPEN).run(
    present.repo,
    present.target,
    present.cause,
    JSON.stringify(present.covers ?? []),
    open.openedKey,
    open.openedAt,
  );
}

/** A held need the line no longer holds: first absence marks it, the second closes it. */
function absent(db: Database, open: OpenNeed, at: string): void {
  if (open.absentAt === null) {
    db.query(
      "UPDATE need_open SET absent_at = ? WHERE repo = ? AND target = ? AND cause = ?",
    ).run(at, open.repo, open.target, open.cause);
    return;
  }
  const lived = parseMs(open.absentAt) - parseMs(open.openedAt);
  insertRow(
    db,
    eventRow(
      "need-closed",
      open.openedKey.replace(/^need-opened/, "need-closed"),
      open.absentAt,
      open,
      howClosed(db, open),
      Number.isFinite(lived) ? Math.max(0, lived) : undefined,
    ),
  );
  dropOpen(db, open);
}

/** A need on the line the log did not hold: its open row, and its place among the held. */
function opened(db: Database, need: LineNeed, at: string): void {
  const key = `need-opened ${need.repo} ${need.target} ${need.cause} ${at}`;
  const why = need.reason === "" ? need.cause : `${need.cause}: ${need.reason}`;
  insertRow(db, eventRow("need-opened", key, at, need, clip(why)));
  db.query(INSERT_OPEN).run(
    need.repo,
    need.target,
    need.cause,
    JSON.stringify(need.covers ?? []),
    key,
    isoFromMs(parseMs(at)),
  );
}

/**
 * Brings the log's open needs in step with the line a tick wrote at `at`: a
 * need on the line the log does not hold opens, a need the log holds that the
 * line does not has been absent one more tick, and closes on its second. Call
 * it once per written line, inside the transaction that writes it.
 */
export function recordNeedRows(
  db: Database,
  needs: readonly LineNeed[],
  at: string,
): void {
  const held = readOpen(db);
  for (const open of held) {
    const present = needs.find((n) => continues(open, n));
    if (present === undefined) absent(db, open, at);
    else keepOpen(db, open, present);
  }
  for (const need of needs)
    if (!held.some((open) => continues(open, need))) opened(db, need, at);
}
