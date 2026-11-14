/**
 * The notices' suppression records (the state database's `notices` table)
 * as the notify and retire steps read them, and the entries of an unread
 * notices comment whose causes they show are settled.
 */
import { HOST_NOTICE } from "../failure-notices.ts";
import { unobservedTarget } from "../notices.ts";
import { entryKeys } from "../runtime/notice-comment.ts";
import { stateDb } from "../state.ts";
import type { RepoReport } from "../types.ts";

export interface Suppression {
  repo: string;
  target: string;
  key: string;
  /** When it was first sent. */
  at: string;
  /** When it was last sent: `at`, or its latest repeat. */
  sentAt: string;
  workspace: string;
  /** Set for a cause notified once for the life of its key: the cause going away does not release it. */
  lasting: boolean;
}

/** The suppression records of `repo`, by key. */
export function readSuppressions(
  repo: string,
  root: string,
): Map<string, Suppression> {
  return suppressionsWhere("repo = ?", [repo], root);
}

/**
 * The suppression records of the host's own failures at any repository, by
 * key, the latest send of a key standing: the destination of such a notice
 * can move, its identity and suppression do not.
 */
export function readHostSuppressions(root: string): Map<string, Suppression> {
  return suppressionsWhere("key LIKE ?", [`${HOST_NOTICE} %`], root);
}

function suppressionsWhere(
  where: string,
  params: string[],
  root: string,
): Map<string, Suppression> {
  const rows = stateDb(root)
    .query(
      `SELECT repo, key, target, workspace, at, sent_at, lasting FROM notices WHERE ${where} ORDER BY COALESCE(sent_at, at)`,
    )
    .all(...params) as Array<
    Omit<Suppression, "lasting" | "sentAt"> & {
      lasting: number;
      sent_at: string | null;
    }
  >;
  return new Map(
    rows.map((r) => [
      r.key,
      {
        repo: r.repo,
        key: r.key,
        target: r.target,
        workspace: r.workspace,
        at: r.at,
        sentAt: r.sent_at ?? r.at,
        lasting: r.lasting === 1,
      },
    ]),
  );
}

/** The suppression records that keep an unread notices workspace: the repository's own and the host failures' at any repository, which can be told here. */
export function retirementRecords(repo: string, root: string): Suppression[] {
  const records = readSuppressions(repo, root);
  for (const [key, record] of readHostSuppressions(root))
    if (!records.has(key)) records.set(key, record);
  return [...records.values()];
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
