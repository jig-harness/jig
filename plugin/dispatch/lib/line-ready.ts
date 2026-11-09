/**
 * The line's Ready to merge: each repository's board read (`board.ts`) as
 * the dashboard reads it, the pull requests in merge now, approve first and
 * update next first, in the board's order, then the converged ones it placed
 * elsewhere. Bounded as the line is: `MAX_READY` cards a repository and
 * `MAX_FAILING` failing checks a card.
 */
import type { LineReady } from "./dashboard-contract.ts";
import type { RepoReport } from "./types.ts";

/** The most cards one repository's board read puts on the line. */
const MAX_READY = 100;

/** The most failing checks one card names. */
const MAX_FAILING = 10;

/** Every repository's placed pull requests, as the line carries them. */
export function readyOf(reports: readonly RepoReport[]): LineReady[] {
  return reports.flatMap((report) => {
    const board = report.board;
    if (board === undefined || report.slug === null) return [];
    const slug = report.slug;
    return board.cards.slice(0, MAX_READY).map(
      (card): LineReady => ({
        repo: slug,
        pr: card.number,
        url: card.url,
        title: card.title,
        head: card.head,
        place: card.place,
        lane: card.lane,
        says: card.says,
        act: card.waitsOn.kind === "person" ? card.waitsOn.act : null,
        waitingFor: card.waitsOn.kind === "waiting" ? card.waitsOn.for : null,
        command: card.command,
        withheld: card.withheld,
        requested: card.requested,
        failing: card.failing.slice(0, MAX_FAILING),
        failingOmitted: Math.max(0, card.failing.length - MAX_FAILING),
        conditions: card.conditions,
        unblocks: card.unblocks,
        since: card.since,
      }),
    );
  });
}

/** The line's word on a repository's board read: why it did not place its pull requests, `null` when it did; nothing when it did not run. */
export function boardUnread(report: RepoReport): {
  boardUnread?: string | null;
  readyOmitted?: number;
} {
  const board = report.board;
  if (board === undefined) return {};
  return {
    boardUnread: board.ok
      ? board.unread.length === 0
        ? null
        : board.unread.map((u) => `#${u.number}: ${u.reason}`).join("; ")
      : (board.reason ?? "not read"),
    readyOmitted: Math.max(0, board.cards.length - MAX_READY),
  };
}
