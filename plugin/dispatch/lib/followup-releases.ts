/**
 * A follow-up's release record, one per merged pull request, in the state
 * database's `followup_releases` table (keyed by the repository and the pull
 * request): written when the tick releases a stale follow-up claim, so that
 * it releases one pull request's claim once. A claim that goes stale again
 * after the release is notified to a person instead.
 *
 * A release is written in two steps around the marker's deletion: pending
 * before it (`released_at` empty), then released, in one transaction with
 * the release's event row, once the forge deleted the marker; an unconfirmed
 * deletion keeps the pending record. A pending record whose marker is
 * still on the pull request is a release a tick began and did not finish,
 * which the next tick finishes; one whose marker is gone counts as a
 * release. Only the host that owns the repository releases a claim, so this
 * host's record is the only one there is. The receipts' retention never
 * removes it.
 */
import { stateRoot } from "../receipts.ts";
import { insertRow, type LogRow } from "./log.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { MarkedPr, StaleClaim } from "./types.ts";

export interface FollowupRelease extends StaleClaim {
  /** The repository's `owner/name`. */
  repo: string;
  pr: number;
  /** When the tick released it; `null` while the release is pending. */
  releasedAt: string | null;
}

/** The release records for the pull requests being classified, by pull request. */
export function readReleases(
  repo: string,
  prs: readonly number[],
  root = stateRoot(),
): Map<number, FollowupRelease> {
  const query = stateDb(root).query(
    `SELECT repo, pr, marker, login, claimant, claimed_at, released_at
     FROM followup_releases WHERE repo = ? AND pr = ?`,
  );
  const rows = [...new Set(prs)].flatMap((pr) => {
    const row = query.get(repo, pr);
    return row === null ? [] : [row];
  }) as Array<{
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

/** Complete pending releases only when a fresh, complete marker listing proves their marker gone. */
export function reconcileReleases(
  releases: Map<number, FollowupRelease>,
  prs: readonly MarkedPr[],
  root = stateRoot(),
): Map<number, FollowupRelease> {
  for (const pr of prs) {
    const release = releases.get(pr.number);
    if (
      release === undefined ||
      release.releasedAt !== null ||
      "unreadable" in pr.markers ||
      pr.markers.some((m) => m.id === release.marker)
    )
      continue;
    const at = new Date().toISOString();
    finishRelease(
      release,
      {
        kind: "event",
        key: `event ${release.repo} PR #${pr.number} follow-up claim released, marker ${release.marker}`,
        at,
        repo: release.repo,
        stage: "followup",
        target: `PR #${pr.number}`,
        event: "followup-released",
        account: null,
        class: "stalled",
        reason: `fresh marker listing confirms pending release of marker ${release.marker}, ${release.claimant}'s claim`,
      },
      root,
    );
    releases.set(pr.number, { ...release, releasedAt: at });
  }
  return releases;
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
