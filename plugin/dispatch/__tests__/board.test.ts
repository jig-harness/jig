/**
 * The board read (`lib/board.ts`): its converged pull requests placed by the
 * Ready predicate, under its deadline and the forge budget's floor, every
 * fact bound to the head the tick's listing gave, one pull request in update
 * next, and each one entering Ready to merge notified once per head.
 */
import { describe, expect, it } from "bun:test";
import type { FactsRead } from "../../skills/drive-pr/scripts/lib/merge-facts.ts";
import type { ForgeFacts } from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import {
  BOARD_DEADLINE_MS,
  type BoardInput,
  type BoardIo,
  observeBoard,
  readBoard,
  readyActions,
  UNKNOWN_WAIT_MS,
} from "../lib/board.ts";
import type { DrivenPr } from "../lib/types.ts";
import { failed, ok } from "../../shared/outcome.ts";

const SLUG = "example-org/example-repo";
const HEAD = "a".repeat(40);
const MOVED = "d".repeat(40);

/** A drive that stopped converged at `head`, at the head it verified. */
function converged(
  number: number,
  heartbeat = "2026-11-08T10:00:00Z",
): DrivenPr {
  return {
    number,
    url: `https://github.com/${SLUG}/pull/${number}`,
    title: `change ${number}`,
    head: HEAD,
    class: "done",
    why: "stopped 0 (converged)",
    evidence: { exit: 0, verifiedSha: HEAD, headSha: HEAD, heartbeat },
  };
}

/** The forge's facts of a clean pull request the reviewer app checked. */
function forge(number: number, over: Partial<ForgeFacts> = {}): ForgeFacts {
  return {
    number,
    head: HEAD,
    draft: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    mergeQueue: false,
    reviewDecision: null,
    authorAssociation: "MEMBER",
    labels: [],
    unresolvedThreads: 0,
    checks: [
      {
        name: "AI review",
        app: "example-review",
        required: false,
        state: "success",
        startedAt: null,
      },
    ],
    reviews: [],
    requested: [],
    methods: { squash: true, merge: false, rebase: false },
    partial: null,
    ...over,
  };
}

function input(drives: DrivenPr[], over: Partial<BoardInput> = {}): BoardInput {
  return {
    slug: SLUG,
    values: { review: { reviewer_app: "example-review" } },
    drives,
    heads: new Map(drives.map((d) => [d.number, HEAD])),
    held: new Set(),
    serialized: { held: new Map() },
    budget: {
      remaining: 4900,
      limit: 5000,
      resetAt: "2026-11-08T11:00:00Z",
    } as BoardInput["budget"],
    ...over,
  };
}

/** A forge that answers each read from `answers` in turn, on a clock the waits move. */
function io(answers: Array<Map<number, ForgeFacts> | Error>): BoardIo & {
  reads: number[][];
  waited: number[];
} {
  let clock = 0;
  const reads: number[][] = [];
  const waited: number[] = [];
  return {
    reads,
    waited,
    read: async (_slug, numbers) => {
      reads.push([...numbers]);
      const next = answers.shift();
      if (next === undefined || next instanceof Error)
        return failed("unreadable", next?.message ?? "no answer");
      const pulls = new Map([...next].filter(([n]) => numbers.includes(n)));
      return ok({
        pulls,
        cost: 1,
        remaining: 4800,
        limit: 5000,
      } satisfies FactsRead);
    },
    wait: async (ms) => {
      waited.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
}

describe("the board read", () => {
  it("places a converged, witnessed, mergeable pull request in merge now with a command pinned to its head", async () => {
    const read = await readBoard(
      input([converged(7)]),
      io([new Map([[7, forge(7)]])]),
    );
    expect(read.ok).toBe(true);
    expect(read.cards.map((c) => [c.number, c.lane, c.command])).toEqual([
      [
        7,
        "merge-now",
        `gh pr merge 7 --repo ${SLUG} --match-head-commit ${HEAD} --squash`,
      ],
    ]);
  });

  it("places one blocked on a required review in approve first, naming who was asked", async () => {
    const read = await readBoard(
      input([converged(7)]),
      io([
        new Map([
          [
            7,
            forge(7, {
              mergeState: "BLOCKED",
              reviewDecision: "REVIEW_REQUIRED",
              requested: ["reviewer-one"],
            }),
          ],
        ]),
      ]),
    );
    const [card] = read.cards;
    expect(card?.lane).toBe("approve-first");
    expect(card?.requested).toEqual(["reviewer-one"]);
    expect(card?.says).toContain("requested from reviewer-one");
  });

  it("puts one whose ledger claims a head its reviewer never checked in Needs you, never merge now", async () => {
    const read = await readBoard(
      input([converged(7)]),
      io([new Map([[7, forge(7, { checks: [] })]])]),
    );
    expect(read.cards.map((c) => [c.place, c.lane, c.command])).toEqual([
      ["needs-you", null, null],
    ]);
  });

  it("reads nothing, and places nothing, when no drive converged", async () => {
    const forgeIo = io([]);
    const read = await readBoard(input([]), forgeIo);
    expect([read.ok, forgeIo.reads]).toEqual([true, []]);
  });

  it("keeps the forge budget for the drives below its floor", async () => {
    const forgeIo = io([]);
    const read = await readBoard(
      input([converged(7)], {
        budget: {
          remaining: 900,
          limit: 5000,
          resetAt: "x",
        } as BoardInput["budget"],
      }),
      forgeIo,
    );
    expect(read.ok).toBe(false);
    expect(read.reason).toContain("kept for the drives");
    expect(forgeIo.reads).toEqual([]);
  });

  it("marks the repository not read, with the reason, when the read fails", async () => {
    const read = await readBoard(
      input([converged(7)]),
      io([new Error("gh api graphql exited 1: HTTP 502")]),
    );
    expect([read.ok, read.cards]).toEqual([false, []]);
    expect(read.reason).toContain("HTTP 502");
  });

  it("reads in the observe phase on the listing's heads, a budget that did not read keeping no floor", async () => {
    const read = await observeBoard(
      {
        ...input([converged(7)]),
        open: [{ number: 7, headRefOid: HEAD }],
        budget: async () => ({ unreadable: "rate_limit did not read" }),
      },
      io([new Map([[7, forge(7)]])]),
    );
    expect(read.cards.map((c) => c.lane)).toEqual(["merge-now"]);
  });

  it("keeps the first read when the second fails: a moved head stays unplaced", async () => {
    const forgeIo = io([
      new Map([[7, forge(7, { head: MOVED })]]),
      new Error("HTTP 502"),
    ]);
    const read = await readBoard(input([converged(7)]), forgeIo);
    expect([read.ok, read.cards, read.pending]).toEqual([true, [], [7]]);
  });

  it("does not place a pull request whose head moved between the tick's reads, after reading it once more", async () => {
    const moved = forge(7, { head: MOVED });
    const forgeIo = io([new Map([[7, moved]]), new Map([[7, moved]])]);
    const read = await readBoard(input([converged(7)]), forgeIo);
    expect(forgeIo.reads).toEqual([[7], [7]]);
    expect(read.cards).toEqual([]);
    expect(read.unread[0]?.reason).toContain("head moved");
  });

  it("reads a pull request the forge is still computing once more, after its wait, within the deadline", async () => {
    const forgeIo = io([
      new Map([[7, forge(7, { mergeable: "UNKNOWN", mergeState: "UNKNOWN" })]]),
      new Map([[7, forge(7)]]),
    ]);
    const read = await readBoard(input([converged(7)]), forgeIo);
    expect(forgeIo.waited).toEqual([UNKNOWN_WAIT_MS]);
    expect(read.cards[0]?.lane).toBe("merge-now");
  });

  it("marks the read not read once it ran past its deadline", async () => {
    const slow: BoardIo = {
      ...io([]),
      read: async (_s, numbers) => {
        now += BOARD_DEADLINE_MS + 1;
        return ok({
          pulls: new Map(numbers.map((n) => [n, forge(n)])),
          cost: 1,
          remaining: null,
          limit: null,
        });
      },
      now: () => now,
    };
    let now = 0;
    const read = await readBoard(input([converged(7)]), slow);
    expect(read.ok).toBe(false);
    expect(read.reason).toContain("deadline");
  });

  it("holds one pull request per repository in update next and puts every other one behind its base in Coming", async () => {
    const behind = (n: number) => forge(n, { mergeState: "BEHIND" });
    const read = await readBoard(
      input([
        converged(7, "2026-11-08T09:00:00Z"),
        converged(8, "2026-11-08T08:00:00Z"),
      ]),
      io([
        new Map([
          [7, behind(7)],
          [8, behind(8)],
        ]),
      ]),
    );
    expect(read.cards.map((c) => [c.number, c.place, c.lane])).toEqual([
      [8, "ready", "update-next"],
      [7, "coming", null],
    ]);
    expect(read.cards[1]?.says).toContain("updated after #8");
  });

  it("names the pull requests a card unblocks in a serialized area, and orders it first in its lane", async () => {
    const read = await readBoard(
      input(
        [
          converged(7, "2026-11-08T09:00:00Z"),
          converged(8, "2026-11-08T08:00:00Z"),
        ],
        {
          serialized: { held: new Map([[12, { area: "state", leader: 7 }]]) },
        },
      ),
      io([
        new Map([
          [7, forge(7)],
          [8, forge(8)],
        ]),
      ]),
    );
    expect(read.cards.map((c) => [c.number, c.unblocks])).toEqual([
      [7, [12]],
      [8, []],
    ]);
  });
});

describe("what a tick could not tell", () => {
  it("names the converged pull requests it could not place, so their notices are not settled by absence", async () => {
    const computing = await readBoard(
      input([converged(7), converged(8)]),
      io([
        new Map([
          [7, forge(7)],
          [
            8,
            forge(8, {
              mergeState: "BLOCKED",
              checks: [
                ...forge(8).checks,
                {
                  name: "t",
                  app: "ci",
                  required: true,
                  state: "pending",
                  startedAt: null,
                },
              ],
            }),
          ],
        ]),
      ]),
    );
    expect(computing.pending).toEqual([8]);
    const failed = await readBoard(
      input([converged(7), converged(8)]),
      io([new Error("down")]),
    );
    expect(failed.pending).toEqual([7, 8]);
  });
});

describe("telling a person", () => {
  it("notifies merge now and approve first once per pull request and verified head, and update next not at all", async () => {
    const read = await readBoard(
      input([converged(7), converged(8), converged(9)]),
      io([
        new Map([
          [7, forge(7)],
          [8, forge(8, { authorAssociation: "CONTRIBUTOR" })],
          [9, forge(9, { mergeState: "BEHIND" })],
        ]),
      ]),
    );
    const actions = readyActions(SLUG, read);
    expect(actions.map((a) => [a.target, a.cause, a.notice?.key])).toEqual([
      ["PR #7", "ready", `${SLUG} PR #7 ready at ${HEAD}`],
      ["PR #8", "ready", `${SLUG} PR #8 ready at ${HEAD}`],
    ]);
    expect(actions[1]?.notice?.text).toContain("nobody is asked");
    // No record text: the pull request's title is not in the message.
    expect(actions[0]?.notice?.text).not.toContain("change 7");
  });

  it("keys a move between the lanes the same, so it does not notify again", async () => {
    const lane = async (over: Partial<ForgeFacts>) =>
      readyActions(
        SLUG,
        await readBoard(
          input([converged(7)]),
          io([new Map([[7, forge(7, over)]])]),
        ),
      )[0]?.notice?.key;
    expect(await lane({})).toBe(
      await lane({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }),
    );
  });
});
