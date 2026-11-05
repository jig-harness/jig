/**
 * The review round record: one count of a pull request's review rounds
 * that every loop working the pull request shares. A round is a distinct
 * head the pull request was reviewed at, so a retried pass on an unchanged
 * push counts nothing. The drive (`drive-state.ts bump-round`, from
 * `drive-status.ts`) and a hand-driven `/resolve-review-comments` loop
 * (`await-round.ts`, through `drive-state.ts count-round`) count into it,
 * whether or not a driver runs; the ledger's `round` and `current-round.ts`
 * read it.
 *
 * It is the drive database's `review_rounds` table (`db.ts`), one row per
 * clone, pull request and head counted, holding that head's ordinal. The
 * pull request's round is the highest ordinal, never lower than the drive
 * state's own `rounds`: a state seeded from another clone's ledger, or kept
 * from a release before this table, carries rounds no row records, and the
 * next head counts past them.
 *
 * A row is `settled` once a hand-driven loop converges past it
 * (`settle-rounds`): the rounds since a loop last converged are what its
 * reflection prompt weighs, while the pull request's round keeps counting
 * across convergences. `drive-state.ts reset` forgets every row of the pull
 * request with the rest of its state.
 *
 * `count-round`, `open-rounds` and `settle-rounds` touch only this table
 * and read the state, so they take no lease: a count keyed by head is the
 * same whichever session writes it. `bump-round` writes the drive state too,
 * and is leased like every other writer of it.
 */
import { fail } from "../cli.ts";
import { canonicalPr, type StateStore } from "./store.ts";
import { type DriveDb, driveDb, inTransaction } from "./db.ts";
import { type DriveState, withProgress } from "./schema.ts";

/** The pull request's highest counted ordinal, 0 when none. */
function highest(drive: DriveDb, pr: string): number {
  const row = drive.db
    .query(
      "SELECT MAX(round) AS round FROM review_rounds WHERE clone = ? AND pr = ?",
    )
    .get(drive.clone, canonicalPr(pr)) as { round: number | null };
  return row.round ?? 0;
}

/**
 * Count `head` as a review round of `pr`, past `floor` (the drive state's
 * `rounds`): the pull request's round after it, and whether `head` was new.
 * A head already counted adds nothing. One transaction, so two loops
 * counting at once never give two heads one ordinal.
 */
function countHead(
  drive: DriveDb,
  pr: string,
  head: string,
  floor: number,
): { round: number; counted: boolean } {
  return inTransaction(drive.db, () => {
    const top = Math.max(highest(drive, pr), floor);
    const inserted = drive.db.run(
      "INSERT OR IGNORE INTO review_rounds (clone, pr, head, round, settled, at) VALUES (?, ?, ?, ?, 0, ?)",
      [drive.clone, canonicalPr(pr), head, top + 1, new Date().toISOString()],
    );
    const counted = inserted.changes === 1;
    return { round: counted ? top + 1 : top, counted };
  });
}

/** The rounds counted for `pr` since a hand-driven loop last converged. */
function openRounds(drive: DriveDb, pr: string): number {
  const row = drive.db
    .query(
      "SELECT COUNT(*) AS n FROM review_rounds WHERE clone = ? AND pr = ? AND settled = 0",
    )
    .get(drive.clone, canonicalPr(pr)) as { n: number };
  return row.n;
}

/** `pr`'s review round: the one number the ledger, the drive and `current-round.ts` report. */
export function reviewRound(store: StateStore, pr: string): number {
  return Math.max(
    highest(driveDb(store.stateDir), pr),
    store.read().state.rounds,
  );
}

/**
 * `bump-round`: count `head` as the drive's round, and set the drive state's
 * `rounds` and `lastCountedHead` from the record in the same transaction
 * and the same hold of the state lock. A head the state already counted is
 * left as it is.
 */
export async function bumpDriveRound(
  store: StateStore,
  pr: string,
  head: string,
): Promise<number> {
  return store.locked(async () => {
    const { state } = store.read();
    if (state.lastCountedHead === head) return state.rounds;
    const drive = driveDb(store.stateDir);
    const next = inTransaction(drive.db, (): DriveState => {
      const { round } = countHead(drive, pr, head, state.rounds);
      const base = { ...state, rounds: round, lastCountedHead: head };
      // Progress only on a round that advanced: a head another loop already
      // counted moves the pointer, not the count.
      const counted =
        round > state.rounds
          ? withProgress(base, "round-advanced", new Date())
          : base;
      store.write(counted);
      return counted;
    });
    await store.renderHandoff(next);
    return next.rounds;
  });
}

/**
 * The verbs a hand-driven loop calls, keyed by command: `count-round --head
 * SHA` prints `{"round": N, "open": M, "counted": true|false}`; `open-rounds` prints the rounds since
 * the loop last converged; `settle-rounds` marks them settled and prints how
 * many it settled.
 */
export const ROUND_VERBS: Readonly<
  Record<string, (store: StateStore, pr: string, head: string) => number>
> = {
  "count-round": (store, pr, head) => {
    if (head === "") fail(2, "count-round requires --head SHA");
    const drive = driveDb(store.stateDir);
    const { round, counted } = countHead(
      drive,
      pr,
      head,
      store.read().state.rounds,
    );
    return print(
      JSON.stringify({ round, open: openRounds(drive, pr), counted }),
    );
  },
  "open-rounds": (store, pr) =>
    print(String(openRounds(driveDb(store.stateDir), pr))),
  "settle-rounds": (store, pr) => {
    const drive = driveDb(store.stateDir);
    const settled = drive.db.run(
      "UPDATE review_rounds SET settled = 1 WHERE clone = ? AND pr = ? AND settled = 0",
      [drive.clone, canonicalPr(pr)],
    );
    return print(String(settled.changes));
  },
};

/** Forget every counted round of `pr`: part of `drive-state.ts reset`. */
export function clearReviewRounds(stateDir: string, pr: string): void {
  const drive = driveDb(stateDir);
  drive.db.run("DELETE FROM review_rounds WHERE clone = ? AND pr = ?", [
    drive.clone,
    canonicalPr(pr),
  ]);
}

function print(line: string): number {
  process.stdout.write(`${line}\n`);
  return 0;
}
