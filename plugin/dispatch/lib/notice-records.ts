/**
 * The suppression records of the notices the tick sends, the state
 * database's `notices` table: one row per repository, notification channel
 * and cause, written once the channel's receipt shows the cause arrived,
 * and the cause's row in the failure ledger while its delivery keeps
 * failing (`failures.ts`).
 *
 * Every channel's records share the table's key, the repository and the
 * `key` column, so a plugin copy one release behind still reads and writes
 * it. The `key` column holds:
 *
 * - for `orca-card`, the notice's key itself; a row that names no channel
 *   is `orca-card`'s (the column's default);
 * - for any other channel, the channel's name, a colon, then the notice's
 *   key (`slack:example-org/web PR #7 ready at 1a2b3c`).
 *
 * The two cannot collide: a notice's key starts with a repository's
 * `owner/name` or with `host `, neither of which holds a colon. The failure
 * ledger's key of a delivery is `notice <key>` on `orca-card` and
 * `notice <channel> <key>` on any other.
 *
 * Releasing a notice's key (a host failure's quiet, `tick-settle.ts`)
 * releases it on every channel.
 */
import type { Database } from "bun:sqlite";
import { insertRow, type LogRow } from "./log.ts";
import { unobservedTarget } from "./notices.ts";
import { entryKeys } from "./runtime/notice-comment.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { RepoReport } from "./types.ts";

/** The channel of today's Orca comment and unread mark, which every record written before channels belongs to. */
export const ORCA_CARD = "orca-card";

/** The `key` column of `channel`'s record of the notice keyed `key`. */
export function recordKey(channel: string, key: string): string {
  return channel === ORCA_CARD ? key : `${channel}:${key}`;
}

/** The notice key a record of `channel` holds in its `key` column. */
function noticeKeyOf(channel: string, stored: string): string {
  const prefix = `${channel}:`;
  return channel !== ORCA_CARD && stored.startsWith(prefix)
    ? stored.slice(prefix.length)
    : stored;
}

/** The failure ledger's key of a delivery of the notice keyed `key` on `channel`. */
export function ledgerKey(channel: string, key: string): string {
  return channel === ORCA_CARD ? `notice ${key}` : `notice ${channel} ${key}`;
}

/** One cause's suppression record on one channel. */
export interface Suppression {
  repo: string;
  target: string;
  /** The notice's key, as the cause carries it. */
  key: string;
  /** When it was first sent. */
  at: string;
  /** When it was last sent: `at`, or its latest repeat. */
  sentAt: string;
  /** Where on the channel it went: for `orca-card`, the workspace's path. */
  workspace: string;
  /** Set for a cause notified once for the life of its key: the cause going away does not release it. */
  lasting: boolean;
}

/** The suppression records of `repo` on `channel`, by notice key. */
export function readSuppressions(
  channel: string,
  repo: string,
  root: string,
): Map<string, Suppression> {
  return suppressionsWhere(channel, "repo = ?", [repo], root);
}

/**
 * The suppression records on `channel` of the host's own failures at any
 * repository, by notice key, the latest send of a key standing: the
 * destination of such a notice can move, its identity and suppression do
 * not.
 */
export function readHostSuppressions(
  channel: string,
  hostPrefix: string,
  root: string,
): Map<string, Suppression> {
  return suppressionsWhere(
    channel,
    "key LIKE ? ESCAPE '\\'",
    [`${likeLiteral(recordKey(channel, `${hostPrefix} `))}%`],
    root,
  );
}

/** `text` as a `LIKE` pattern that matches it alone, under `ESCAPE '\'`. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function suppressionsWhere(
  channel: string,
  where: string,
  params: string[],
  root: string,
): Map<string, Suppression> {
  const rows = stateDb(root)
    .query(
      `SELECT repo, key, target, workspace, at, sent_at, lasting FROM notices WHERE channel = ? AND ${where} ORDER BY COALESCE(sent_at, at)`,
    )
    .all(channel, ...params) as Array<
    Omit<Suppression, "lasting" | "sentAt"> & {
      lasting: number;
      sent_at: string | null;
    }
  >;
  return new Map(
    rows.map((r) => {
      const key = noticeKeyOf(channel, r.key);
      return [
        key,
        {
          repo: r.repo,
          key,
          target: r.target,
          workspace: r.workspace,
          at: r.at,
          sentAt: r.sent_at ?? r.at,
          lasting: r.lasting === 1,
        },
      ];
    }),
  );
}

/**
 * Write a cause's suppression record on `channel`, and its event row with
 * it in one transaction; the record that is already there stands, and so
 * does an event row under the same key, which the first channel to send the
 * cause wrote. A
 * repeat moves the record's last send and its place, and writes no event
 * row: the cause's row was written when it was first sent.
 */
export function suppress(
  channel: string,
  record: Omit<Suppression, "sentAt">,
  event: LogRow | null,
  root: string,
  repeat: boolean,
): void {
  const db = stateDb(root);
  const key = recordKey(channel, record.key);
  if (repeat) {
    db.query(
      "UPDATE notices SET sent_at = ?, workspace = ? WHERE repo = ? AND key = ?",
    ).run(record.at, record.workspace, record.repo, key);
    return;
  }
  inTransaction(db, () => {
    const written = db
      .query(
        `INSERT INTO notices (repo, key, target, workspace, at, lasting, channel)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo, key) DO NOTHING`,
      )
      .run(
        record.repo,
        key,
        record.target,
        record.workspace,
        record.at,
        record.lasting ? 1 : 0,
        channel,
      );
    if (written.changes === 1 && event !== null) insertRow(db, event);
  });
}

/** Drop `channel`'s records of these notice keys. */
export function dropSuppressions(
  channel: string,
  records: ReadonlyArray<{ repo: string; key: string }>,
  root: string,
): void {
  if (records.length === 0) return;
  const db = stateDb(root);
  const drop = db.query("DELETE FROM notices WHERE repo = ? AND key = ?");
  inTransaction(db, () => {
    for (const r of records) drop.run(r.repo, recordKey(channel, r.key));
  });
}

/** A statement that drops every channel's records of the notice key it is run with, at any repository. */
export function releaseOnEveryChannel(db: Database): {
  run(key: string): void;
} {
  const release = db.query(
    "DELETE FROM notices WHERE key = ?1 OR (channel <> ?2 AND key = channel || ':' || ?1)",
  );
  return { run: (key) => release.run(key, ORCA_CARD) };
}

/**
 * The notice keys of the weights notices recorded on any channel at any
 * repository. Each channel is asked for the range of keys that begin with
 * its qualified prefix, which the (channel, key) index bounds, so the
 * history of other notices is never scanned.
 */
export function storedWeightsKeys(db: Database, prefix: string): Set<string> {
  const channels = db
    .query("SELECT DISTINCT channel FROM notices")
    .all() as Array<{ channel: string }>;
  const range = db.query(
    "SELECT key FROM notices WHERE channel = ?1 AND key >= ?2 AND key < ?3",
  );
  const found = new Set<string>();
  for (const { channel } of channels) {
    const from = recordKey(channel, prefix);
    const rows = range.all(channel, from, `${from}\u{10FFFF}`) as Array<{
      key: string;
    }>;
    for (const r of rows) {
      const key = noticeKeyOf(channel, r.key);
      if (key.startsWith(prefix)) found.add(key);
    }
  }
  return found;
}

/** When each notice of `repo` was first sent, on whichever channel sent it first, by notice key. */
export function firstSends(db: Database, repo: string): Map<string, string> {
  const rows = db
    .query("SELECT channel, key, at FROM notices WHERE repo = ? ORDER BY at")
    .all(repo) as Array<{ channel: string; key: string; at: string }>;
  const first = new Map<string, string>();
  for (const r of rows) {
    const key = noticeKeyOf(r.channel, r.key);
    if (!first.has(key)) first.set(key, r.at);
  }
  return first;
}

/**
 * The keys of the entries in `comment` whose cause is settled: on a tick
 * that read every record whole, the tick names no cause under the key and
 * no record that still stands carries it (a record notified once for the
 * life of its key stands only while its target goes unobserved), the same
 * test that retires an unread notices workspace.
 */
export function settledEntries(
  comment: string,
  report: RepoReport,
  standing: ReadonlySet<string>,
  records: readonly Suppression[],
): string[] {
  if (!report.records.every((r) => r.ok)) return [];
  const kept = new Set(
    records
      .filter((r) => !r.lasting || unobservedTarget(report, r.target))
      .map((r) => r.key),
  );
  return entryKeys(comment).filter((k) => !standing.has(k) && !kept.has(k));
}
