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
 *
 * A channel's first send on this host starts it from the causes that
 * already stand (`channelStarted`, `markChannelStarted`): one row per
 * repository under the key `channel started <repository>`, at no repository,
 * is the record that the channel has begun on that repository, so that a
 * channel which has sent nothing yet there is not mistaken for a new one
 * when its first cause appears. A record of a send at the repository says the
 * same; the silent records of a start that did not complete do not. A
 * channel's records and those rows go together.
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

/** The stored workspace of a record that only says a cause was known when its channel started: nothing was sent, so it is no send's history. */
export const SILENT_START = "channel start";

/** The stored key of the row that records a channel's start on one repository, at no repository: no notice's key reads like it, since a notice's key starts with a repository's `owner/name` or with `host `. */
function startedKey(channel: string, repo: string): string {
  return recordKey(channel, `channel started ${repo}`);
}

/** Whether `channel` has begun on `repo`: its start row there, or a record of a send it holds there (one an earlier release wrote). The silent records of a start that did not complete are no send. */
export function channelStarted(
  channel: string,
  repo: string,
  root: string,
): boolean {
  return (
    stateDb(root)
      .query(
        "SELECT 1 AS found FROM notices WHERE channel = ?1 AND ((repo = '' AND key = ?2) OR (repo = ?3 AND workspace <> ?4)) LIMIT 1",
      )
      .get(channel, startedKey(channel, repo), repo, SILENT_START) !== null
  );
}

/** Record that `channel` has begun on `repo`; the row stays, and the record's key never meets a notice's. */
export function markChannelStarted(
  channel: string,
  repo: string,
  at: string,
  root: string,
): void {
  stateDb(root)
    .query(
      `INSERT INTO notices (repo, key, target, workspace, at, lasting, channel)
       VALUES ('', ?, '', '', ?, 1, ?) ON CONFLICT (repo, key) DO NOTHING`,
    )
    .run(startedKey(channel, repo), at, channel);
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
    inTransaction(db, () => {
      const silent =
        db
          .query(
            "SELECT 1 AS found FROM notices WHERE repo = ?1 AND key = ?2 AND workspace = ?3",
          )
          .get(record.repo, key, SILENT_START) !== null;
      db.query(
        "UPDATE notices SET sent_at = ?1, at = CASE WHEN workspace = ?5 THEN ?1 ELSE at END, workspace = ?2 WHERE repo = ?3 AND key = ?4",
      ).run(record.at, record.workspace, record.repo, key, SILENT_START);
      // The first real delivery of a cause only recorded silently writes its event row.
      if (silent && event !== null && record.workspace !== SILENT_START)
        insertRow(db, event);
    });
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
 * The weights notices recorded on any channel at any repository, each as
 * the channel and stored key that identify its rows and the notice key.
 * Each channel is asked for the range of keys that begin with its qualified
 * prefix, which the (channel, key) index bounds, so the history of other
 * notices is never scanned.
 */
export function storedWeightsRecords(
  db: Database,
  prefix: string,
): Array<{ channel: string; stored: string; key: string }> {
  // The channels are found by skipping from one to the next through the (channel, key) index, one
  // seek each, so the cost follows the number of channels and not the history of notices.
  const next = db.query(
    "SELECT MIN(channel) AS channel FROM notices WHERE channel > ?",
  );
  const channels: string[] = [];
  for (
    let row = db.query("SELECT MIN(channel) AS channel FROM notices").get() as {
      channel: string | null;
    };
    row.channel !== null;
    row = next.get(row.channel) as { channel: string | null }
  )
    channels.push(row.channel);
  const range = db.query(
    "SELECT DISTINCT key FROM notices WHERE channel = ?1 AND key >= ?2 AND key < ?3",
  );
  const found: Array<{ channel: string; stored: string; key: string }> = [];
  for (const channel of channels) {
    const from = recordKey(channel, prefix);
    const rows = range.all(channel, from, `${from}\u{10FFFF}`) as Array<{
      key: string;
    }>;
    for (const r of rows) {
      const key = noticeKeyOf(channel, r.key);
      if (key.startsWith(prefix)) found.push({ channel, stored: r.key, key });
    }
  }
  return found;
}

/** The notice keys of the weights notices recorded on any channel at any repository. */
export function storedWeightsKeys(db: Database, prefix: string): Set<string> {
  return new Set(storedWeightsRecords(db, prefix).map((r) => r.key));
}

/** Drop the rows of these stored keys on their channels, at every repository, through the (channel, key) index. */
export function dropStoredRecords(
  db: Database,
  records: ReadonlyArray<{ channel: string; stored: string }>,
): void {
  if (records.length === 0) return;
  const drop = db.query("DELETE FROM notices WHERE channel = ? AND key = ?");
  inTransaction(db, () => {
    for (const r of records) drop.run(r.channel, r.stored);
  });
}

/** When each notice of `repo` was first sent, on whichever channel sent it first, by notice key. */
export function firstSends(db: Database, repo: string): Map<string, string> {
  const rows = db
    .query(
      "SELECT channel, key, at FROM notices WHERE repo = ? AND workspace <> ? ORDER BY at",
    )
    .all(repo, SILENT_START) as Array<{
    channel: string;
    key: string;
    at: string;
  }>;
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
