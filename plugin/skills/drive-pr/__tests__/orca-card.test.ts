import { describe, expect, test } from "bun:test";
import { orcaAnswering } from "../../../../lib/test-helpers/orca-answering.ts";
import { updateBoard } from "../../../shared/orca-board.ts";
import {
  type CardDeps,
  cardOnReady,
  cardOnStop,
  stopComment,
} from "../scripts/lib/driver/orca-card.ts";
import {
  MAX_ROUNDS_EXIT,
  MAILBOX_STOPPED_EXIT,
  PASS_DEADLINE_EXIT,
  QUOTA_PARKED_EXIT,
  STALLED_EXIT,
  TAKEN_OVER_EXIT,
  WORKTREE_UNCLEAN_EXIT,
} from "../scripts/lib/driver/settings.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const ID = "repo-1::/ws/app/feat-x";
const current = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const set = current;
const setArgs = (...flags: string[]) =>
  ["worktree set --worktree", `id:${ID}`, ...flags, "--json"].join(" ");
const showArgs = `worktree show --worktree id:${ID} --json`;
const unreadCard = JSON.stringify({
  ok: true,
  result: { worktree: { id: ID, comment: "an earlier note", isUnread: true } },
});

const readCard = JSON.stringify({
  ok: true,
  result: { worktree: { id: ID, comment: null, isUnread: false } },
});

const HITL_PARKED_EXIT = 8;
const REVIEWER_FAILED_EXIT = 7;

function parkedState(...questions: string[]): DriveState {
  return {
    ...freshState(42),
    parked: questions.map((reason, i) => ({
      key: `t${i}`,
      kind: "thread" as const,
      reason,
      round: 2,
    })),
  };
}

/** Deps that answer Orca from `answers` and count the state reads. */
function deps(
  answers: Record<string, string>,
  state: DriveState | null = null,
  env: Record<string, string | undefined> = ORCA,
) {
  const { calls, runner } = orcaAnswering(answers);
  const reads: string[] = [];
  const d: CardDeps = {
    env,
    update: (update) => updateBoard(update, env, runner, () => ({})),
    readState: async (pr) => {
      reads.push(pr);
      return state;
    },
  };
  return { calls, reads, deps: d };
}

describe("the stop's comment", () => {
  test("a park names its question, and how many more wait", () => {
    expect(
      stopComment("42", HITL_PARKED_EXIT, parkedState("Which release?")),
    ).toBe("PR #42 parked: Which release?");
    expect(
      stopComment(
        "42",
        HITL_PARKED_EXIT,
        parkedState("Which\nrelease?", "Rename it?", "Ship it?"),
      ),
    ).toBe("PR #42 parked: Which release? (and 2 more decisions)");
    expect(stopComment("42", HITL_PARKED_EXIT, null)).toBe(
      "PR #42 parked: a decision waits for a person (exit 8)",
    );
  });

  test("a usage-limit stop names the wall and its reset", () => {
    const state: DriveState = {
      ...freshState(42),
      quotaPark: {
        vendor: "claude",
        window: "7d",
        resetAt: "2026-11-04T10:00:00Z",
        at: "2026-11-02T10:00:00Z",
      },
    };
    expect(stopComment("42", QUOTA_PARKED_EXIT, state)).toBe(
      "PR #42 stopped on a claude 7d-window usage limit, which resets 2026-11-04T10:00:00Z (exit 16)",
    );
    expect(stopComment("42", QUOTA_PARKED_EXIT, null)).toBe(
      "PR #42 stopped on a usage limit, which resets at an unknown time (exit 16)",
    );
  });

  test("each failure stop says what stopped it", () => {
    const causes: Array<[number, string]> = [
      [1, "stopped on a failure; the drive's log says what failed"],
      [
        2,
        "stopped: a usage error, or a gh that cannot report the pull request",
      ],
      [MAX_ROUNDS_EXIT, "used its round budget without converging"],
      [
        REVIEWER_FAILED_EXIT,
        "stopped: the posting reviewer's check did not pass",
      ],
      [9, "stopped: it conflicts with its base and has nothing left to work"],
      [22, "stopped: the reviewer skipped its head and will not review it"],
      [
        WORKTREE_UNCLEAN_EXIT,
        "converged, but its worktree holds changes no round shipped",
      ],
      [STALLED_EXIT, "stalled: its passes changed nothing"],
      [PASS_DEADLINE_EXIT, "stopped: its passes kept running out of time"],
    ];
    for (const [code, cause] of causes)
      expect(stopComment("42", code, null)).toBe(
        `PR #42's drive ${cause} (exit ${code})`,
      );
  });

  test("a stop no person settles leaves no comment", () => {
    for (const code of [
      0,
      3,
      4,
      5,
      11,
      13,
      MAILBOX_STOPPED_EXIT,
      19,
      TAKEN_OVER_EXIT,
    ])
      expect(stopComment("42", code, null)).toBeNull();
  });
});

describe("in an Orca terminal", () => {
  test("marking Ready moves the card to in-review with the pull request linked", async () => {
    const { calls, deps: d } = deps({
      "worktree current --json": current,
      [setArgs("--workspace-status", "in-review", "--pr", "42")]: set,
    });
    await cardOnReady("42", d);
    expect(calls).toEqual([
      "worktree current --json",
      setArgs("--workspace-status", "in-review", "--pr", "42"),
    ]);
  });

  test("a park marks the card unread with its question as the comment", async () => {
    const comment = "PR #42 parked: Which release carries it?";
    const {
      calls,
      reads,
      deps: d,
    } = deps(
      {
        "worktree current --json": current,
        [showArgs]: unreadCard,
        [setArgs("--unread", "--comment", `an earlier note\n${comment}`)]: set,
      },
      parkedState("Which release carries it?"),
    );
    await cardOnStop("42", HITL_PARKED_EXIT, d);
    expect(reads).toEqual(["42"]);
    expect(calls[2]).toBe(
      setArgs("--unread", "--comment", `an earlier note\n${comment}`),
    );
  });

  test("a failure stop marks the card unread without reading the drive state", async () => {
    const comment =
      "PR #42's drive stopped: the posting reviewer's check did not pass (exit 7)";
    const {
      calls,
      reads,
      deps: d,
    } = deps({
      "worktree current --json": current,
      [showArgs]: readCard,
      [setArgs("--unread", "--comment", comment)]: set,
    });
    await cardOnStop("42", REVIEWER_FAILED_EXIT, d);
    expect(reads).toEqual([]);
    expect(calls[2]).toBe(setArgs("--unread", "--comment", comment));
  });

  test("a converged drive moves nothing", async () => {
    const { calls, reads, deps: d } = deps({});
    await cardOnStop("42", 0, d);
    expect([calls, reads]).toEqual([[], []]);
  });

  test("an Orca failure only warns", async () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      const { deps: d } = deps({
        "worktree current --json": JSON.stringify({
          ok: false,
          error: { code: "runtime_unavailable" },
        }),
      });
      await cardOnReady("42", d);
      await cardOnStop("42", STALLED_EXIT, d);
      const failedOrca = warnings.length;
      expect(failedOrca).toBe(2);
      for (const line of warnings) expect(line).toContain("⚠");
      const throwing: CardDeps = {
        ...d,
        update: async () => {
          throw new Error("spawn refused");
        },
        readState: async () => {
          throw new Error("state unreadable");
        },
      };
      await cardOnReady("42", throwing);
      await cardOnStop("42", HITL_PARKED_EXIT, throwing);
      const thrown = warnings.slice(failedOrca);
      expect(thrown.some((l) => l.includes("spawn refused"))).toBe(true);
      expect(thrown.some((l) => l.includes("state unreadable"))).toBe(true);
    } finally {
      console.error = original;
    }
  });
});

describe("outside Orca", () => {
  test("nothing is read or called", async () => {
    const { calls, reads, deps: d } = deps({}, parkedState("Why?"), {});
    await cardOnReady("42", d);
    await cardOnStop("42", HITL_PARKED_EXIT, d);
    await cardOnStop("42", QUOTA_PARKED_EXIT, d);
    expect([calls, reads]).toEqual([[], []]);
  });
});
