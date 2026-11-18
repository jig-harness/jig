/** A release's tracker item and authorization belong to the version, not to a merged pull request. */
import { stateRoot } from "../receipts.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { inTransaction, stateDb } from "./state.ts";
import { SHARED_RELEASE_LIMIT } from "../../shared/records/release-tags.ts";
import { releaseActions } from "./release-groups.ts";
import type { Action, MarkedPr } from "./types.ts";

export interface ReleaseNeed {
  tag: string;
  item: string | null;
  launch: string;
  rerun_claimed: number;
  tagged: number;
  /** The decision a person took the release under (`release-groups.ts`); `null` when none did. */
  taken_as: string | null;
}

export type ReleaseReservation =
  | { status: "reserved" | "reserved-elsewhere" | "delegated" }
  | { status: "recorded"; item: string };

function readNeed(
  db: ReturnType<typeof stateDb>,
  repo: string,
  tag: string,
): ReleaseNeed | null {
  return db
    .query("SELECT * FROM release_needs WHERE repo = ? AND tag = ?")
    .get(repo, tag) as ReleaseNeed | null;
}

/** Assign a new or abandoned reservation, retaining work held by an active pass or the owner. */
function reserveReleaseIn(
  db: ReturnType<typeof stateDb>,
  repo: string,
  tag: string,
  launch: string,
): void {
  db.query(
    `INSERT INTO release_needs (repo, tag, launch) VALUES (?, ?, ?)
         ON CONFLICT (repo, tag) DO UPDATE SET launch = excluded.launch
         WHERE release_needs.item IS NULL AND release_needs.launch NOT LIKE 'shared:%' AND NOT EXISTS (
           SELECT 1 FROM launches
           WHERE id = release_needs.launch AND result IS NULL AND exit IS NULL
         )`,
  ).run(repo, tag, launch);
}

/** Reserve filing before search/create. Another launch can take over only after the holder ended. */
export function reserveRelease(
  repo: string,
  tag: string,
  launch: string,
  item: string | undefined,
  root = stateRoot(),
): Outcome<ReleaseReservation, "refused"> {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const prior = readNeed(db, repo, tag);
    if (prior?.item != null)
      return ok({ status: "recorded", item: prior.item });
    if (item === undefined) {
      reserveReleaseIn(db, repo, tag, launch);
      return ok({
        status:
          readNeed(db, repo, tag)?.launch === launch
            ? "reserved"
            : "reserved-elsewhere",
      });
    }
    if (prior?.launch !== launch)
      return failed(
        "refused",
        "this follow-up must reserve the release before recording its tracker item",
      );
    const written = db
      .query(
        "UPDATE OR IGNORE release_needs SET item = ? WHERE repo = ? AND tag = ?",
      )
      .run(item, repo, tag);
    return written.changes === 1
      ? ok({ status: "recorded", item })
      : failed(
          "refused",
          "this tracker item already belongs to another release",
        );
  });
}

export function releaseNeeds(repo: string, root = stateRoot()): ReleaseNeed[] {
  return stateDb(root)
    .query(
      "SELECT * FROM release_needs WHERE repo = ? AND item IS NOT NULL AND tagged = 0 ORDER BY tag",
    )
    .all(repo) as ReleaseNeed[];
}

export function releaseNeedActions(needs: readonly ReleaseNeed[]): Action[] {
  return releaseActions(
    needs.flatMap((need) =>
      need.item === null ? [] : [{ ...need, item: need.item }],
    ),
  );
}

export function recordTagged(
  repo: string,
  tags: readonly string[],
  root = stateRoot(),
): void {
  const db = stateDb(root);
  const update = db.query(
    "UPDATE release_needs SET tagged = 1 WHERE repo = ? AND tag = ?",
  );
  inTransaction(db, () => {
    for (const tag of tags) update.run(repo, tag);
  });
}

/** A person's answer took these releases under `decision`, which stays theirs while the other versions change; `null` returns them to the line. */
export function recordReleasesTaken(
  repo: string,
  tags: readonly string[],
  decision: string | null,
  root = stateRoot(),
): void {
  const db = stateDb(root);
  const update = db.query(
    "UPDATE release_needs SET taken_as = ? WHERE repo = ? AND tag = ?",
  );
  inTransaction(db, () => {
    for (const tag of tags) update.run(decision, repo, tag);
  });
}

/** A second approval of the same release never sends the same write again. */
export function claimReleaseRerun(
  repo: string,
  tag: string,
  root = stateRoot(),
): boolean {
  return (
    stateDb(root)
      .query(
        "UPDATE release_needs SET rerun_claimed = 1 WHERE repo = ? AND tag = ? AND tagged = 0 AND rerun_claimed = 0",
      )
      .run(repo, tag).changes === 1
  );
}

/** Use the previous tag observation until its next check is due. */
export function dueReleaseTags(
  repo: string,
  now: number,
  root = stateRoot(),
): string[] {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const due = db
      .query(
        `SELECT tag FROM release_needs WHERE repo = ? AND item IS NOT NULL
       AND tagged = 0 AND next_tag_check <= ? ORDER BY next_tag_check, tag LIMIT 20`,
      )
      .all(repo, now) as { tag: string }[];
    const defer = db.query(
      "UPDATE release_needs SET next_tag_check = ? WHERE repo = ? AND tag = ?",
    );
    for (const { tag } of due) defer.run(now + 5 * 60_000, repo, tag);
    return due.map(({ tag }) => tag);
  });
}

/** Each non-owner pass keeps a handoff it can publish on its own follow-up marker. */
export function delegateRelease(
  repo: string,
  tag: string,
  launch: string,
  root = stateRoot(),
): Outcome<ReleaseReservation, "refused"> {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const tags = releaseHandoffTags(repo, launch, root);
    if (tags.includes(tag)) return ok({ status: "delegated" });
    if (tags.length >= SHARED_RELEASE_LIMIT)
      return failed("refused", "this follow-up's release handoff is full");
    const written = db
      .query(
        "UPDATE launches SET release_tags = ? WHERE repo = ? AND id = ? AND result IS NULL AND exit IS NULL",
      )
      .run(
        JSON.stringify(
          [...tags, tag].sort((left, right) => left.localeCompare(right)),
        ),
        repo,
        launch,
      );
    return written.changes === 1
      ? ok({ status: "delegated" })
      : failed(
          "refused",
          "this follow-up ended before it recorded the release",
        );
  });
}

/** Tags a non-owner pass owes the owner. */
export function releaseHandoffTags(
  repo: string,
  launch: string,
  root = stateRoot(),
): string[] {
  const rows = stateDb(root)
    .query(
      "SELECT value AS tag FROM launches, json_each(launches.release_tags) WHERE repo = ? AND launches.id = ? AND action = 'followup'",
    )
    .all(repo, launch) as { tag: string }[];
  return rows.map(({ tag }) => tag);
}

/** Carry the winning trusted marker's handoff beyond the merge read window. */
export function adoptReleaseHandoffs(
  repo: string,
  merged: readonly MarkedPr[],
  root = stateRoot(),
): void {
  const db = stateDb(root);
  inTransaction(db, () => {
    for (const pr of merged) {
      if ("unreadable" in pr.markers) continue;
      const winner = pr.markers.find((m) => m.trusted);
      if (winner?.run.kind !== "tick" || winner.run.owner !== false) continue;
      for (const tag of winner.run.releaseTags ?? [])
        reserveReleaseIn(db, repo, tag, `shared:${pr.number}`);
    }
  });
}

/** One owner handoff retry wakes per tick; other follow-ups reuse this reservation. */
export function nextReleaseHandoff(
  repo: string,
  now: number,
  root = stateRoot(),
): ReleaseNeed | null {
  const db = stateDb(root);
  return inTransaction(db, () => {
    const due = db
      .query(
        `SELECT * FROM release_needs WHERE repo = ? AND item IS NULL
       AND tagged = 0 AND launch LIKE 'shared:%' AND next_tag_check <= ?
       ORDER BY next_tag_check, tag LIMIT 1`,
      )
      .get(repo, now) as ReleaseNeed | null;
    if (due !== null)
      db.query(
        "UPDATE release_needs SET next_tag_check = ? WHERE repo = ? AND tag = ?",
      ).run(now + 5 * 60_000, repo, due.tag);
    return due;
  });
}
