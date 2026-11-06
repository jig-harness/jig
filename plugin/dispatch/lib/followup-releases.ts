/**
 * A follow-up's release record, one per merged pull request, in the state
 * database's `followup_releases` table (keyed by the repository and the pull
 * request): written when the tick releases a stale follow-up claim, so that
 * it releases one pull request's claim once. A claim that goes stale again
 * after the release is notified to a person instead.
 *
 * A release is written in two steps around the marker's deletion: pending
 * before it (`released_at` empty), then released, in one transaction with
 * the release's event row, once the forge deleted the marker; a deletion the
 * forge refuses removes the pending record. A pending record whose marker is
 * still on the pull request is a release a tick began and did not finish,
 * which the next tick finishes; one whose marker is gone counts as a
 * release. Only the host that owns the repository releases a claim, so this
 * host's record is the only one there is. The receipts' retention never
 * removes it.
 */
import { stateRoot } from "../receipts.ts";
import { insertRow, type LogRow } from "./log.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { StaleClaim } from "./types.ts";

export interface FollowupRelease extends StaleClaim {
  /** The repository's `owner/name`. */
  repo: string;
  pr: number;
  /** When the tick released it; `null` while the release is pending. */
  releasedAt: string | null;
}

/** The release records of `repo`, by pull request. */
export function readReleases(
  repo: string,
  root = stateRoot(),
): Map<number, FollowupRelease> {
  const rows = stateDb(root)
    .query(
      `SELECT repo, pr, marker, login, claimant, claimed_at, released_at
       FROM followup_releases WHERE repo = ?`,
    )
    .all(repo) as Array<{
    repo: string;
    pr: number;
    marker: number;
    login: string;
    claimant: string;
    claimed_at: string;
    released_at: string | null;
  }>;
  return new Map(
    rows.map((r) => [
      r.pr,
      {
        repo: r.repo,
        pr: r.pr,
        marker: r.marker,
        login: r.login,
        claimant: r.claimant,
        claimedAt: r.claimed_at,
        releasedAt: r.released_at,
      },
    ]),
  );
}

/** Write a pending release record before the marker is deleted; false when another marker's release already stands for the pull request. */
export function beginRelease(
  release: Omit<FollowupRelease, "releasedAt">,
  root = stateRoot(),
): boolean {
  const db = stateDb(root);
  db.query(
    `INSERT INTO followup_releases
       (repo, pr, marker, login, claimant, claimed_at, released_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (repo, pr) DO NOTHING`,
  ).run(
    release.repo,
    release.pr,
    release.marker,
    release.login,
    release.claimant,
    release.claimedAt,
  );
  const row = db
    .query("SELECT marker FROM followup_releases WHERE repo = ? AND pr = ?")
    .get(release.repo, release.pr) as { marker: number } | null;
  return row?.marker === release.marker;
}

/** Mark a pending release released, with its event row, in one transaction, once the forge deleted the marker. */
export function finishRelease(
  release: Pick<FollowupRelease, "repo" | "pr" | "marker">,
  event: LogRow,
  root = stateRoot(),
): void {
  const db = stateDb(root);
  inTransaction(db, () => {
    const written = db
      .query(
        `UPDATE followup_releases SET released_at = ?
         WHERE repo = ? AND pr = ? AND marker = ? AND released_at IS NULL`,
      )
      .run(event.at, release.repo, release.pr, release.marker);
    if (written.changes === 1) insertRow(db, event);
  });
}

/** Remove a pending release whose marker the forge did not delete, so the claim is still released once. */
export function dropRelease(
  release: Pick<FollowupRelease, "repo" | "pr" | "marker">,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `DELETE FROM followup_releases
       WHERE repo = ? AND pr = ? AND marker = ? AND released_at IS NULL`,
    )
    .run(release.repo, release.pr, release.marker);
}
