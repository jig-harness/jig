import { describe, expect, test } from "bun:test";
import { ExitError } from "../cli.ts";
import { orcaAnswering } from "../../../lib/test-helpers/orca-answering.ts";
import type { OrcaRunner } from "../orca.ts";
import {
  BOARD_STAGES,
  boardColumns,
  parseArgs,
  updateBoard,
} from "../orca-board.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const ID = "repo-1::/ws/app/feat-x";
const noConfig = () => ({});

const current = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const set = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const setArgs = (...flags: string[]) =>
  ["worktree set --worktree", `id:${ID}`, ...flags, "--json"].join(" ");

describe("outside Orca", () => {
  test("makes no call and reads no configuration", async () => {
    const { calls, runner } = orcaAnswering({});
    let read = false;
    const config = () => {
      read = true;
      return {};
    };
    for (const update of [
      { stage: "in-review" as const },
      { unread: true, comment: "PR #4 parked: which one?" },
    ])
      expect(await updateBoard(update, {}, runner, config)).toBe(
        "orca-board: not in Orca; nothing to do",
      );
    expect(calls).toEqual([]);
    expect(read).toBe(false);
  });
});

describe("in an Orca terminal", () => {
  test("sets the working directory's card and links the pull request", async () => {
    const { calls, commands, runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("--workspace-status", "in-review", "--pr", "42")]: set,
    });
    expect(
      await updateBoard(
        { stage: "in-review", pr: "42" },
        ORCA,
        runner,
        noConfig,
      ),
    ).toBe("orca-board: in-review, PR #42 linked");
    expect(calls).toEqual([
      "worktree current --json",
      setArgs("--workspace-status", "in-review", "--pr", "42"),
    ]);
    expect(commands).toEqual([ORCA.ORCA_CLI_COMMAND, ORCA.ORCA_CLI_COMMAND]);
  });

  test("marks the card unread with a comment, leaving its column alone", async () => {
    const comment = "PR #42 parked: which release carries it?";
    const { calls, runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("--unread", "--comment", comment)]: set,
    });
    expect(
      await updateBoard({ unread: true, comment }, ORCA, runner, noConfig),
    ).toBe("orca-board: marked unread, comment set");
    expect(calls[1]).toBe(setArgs("--unread", "--comment", comment));
  });

  test("passes every flag together, the comment as one argument", async () => {
    const comment = "merged; release 0.121.0 owed";
    const seen: string[][] = [];
    const runner: OrcaRunner = async (_command, args) => {
      seen.push(args);
      return { code: 0, stdout: current, stderr: "" };
    };
    await updateBoard(
      { stage: "completed", pr: "7", unread: true, comment },
      ORCA,
      runner,
      noConfig,
    );
    expect(seen[1]).toEqual([
      "worktree",
      "set",
      "--worktree",
      `id:${ID}`,
      "--workspace-status",
      "completed",
      "--pr",
      "7",
      "--unread",
      "--comment",
      comment,
      "--json",
    ]);
  });

  test("moves the card to the column orca.board maps the stage onto", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("--workspace-status", "review")]: set,
    });
    const config = () => ({ orca: { board: { in_review: "review" } } });
    expect(
      await updateBoard({ stage: "in-review" }, ORCA, runner, config),
    ).toBe("orca-board: review");
    expect(calls[1]).toBe(setArgs("--workspace-status", "review"));
  });

  test("only warns, without calling Orca, when orca.board cannot be read", async () => {
    const { calls, runner } = orcaAnswering({});
    for (const config of [
      () => ({ orca: { board: { shipping: "done" } } }),
      () => ({ orca: { board: "in-review" } }),
      () => {
        throw new Error("the configuration file is not YAML");
      },
    ])
      expect(
        await updateBoard({ stage: "completed" }, ORCA, runner, config),
      ).toContain("⚠");
    expect(calls).toEqual([]);
  });

  test("never reads the configuration for an update without a stage", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("--unread")]: set,
    });
    const config = () => {
      throw new Error("read");
    };
    expect(await updateBoard({ unread: true }, ORCA, runner, config)).toBe(
      "orca-board: marked unread",
    );
  });

  test("refuses a comment Orca would read as a flag", async () => {
    const { calls, runner } = orcaAnswering({});
    expect(
      await updateBoard({ comment: "--read" }, ORCA, runner, noConfig),
    ).toContain("⚠");
    expect(calls).toEqual([]);
  });

  test("leaves a directory Orca does not list alone", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": JSON.stringify({
        ok: false,
        error: { code: "selector_not_found" },
      }),
    });
    expect(
      await updateBoard({ stage: "in-progress" }, ORCA, runner, noConfig),
    ).toContain("does not list this directory");
    expect(calls).toHaveLength(1);
  });

  test("warns, without updating, when the worktree lookup itself fails", async () => {
    for (const done of [
      { code: 127, stdout: "", stderr: "orca: command not found" },
      { code: 124, stdout: current, stderr: "" },
      { code: 1, stdout: "", stderr: "runtime unavailable" },
    ]) {
      const calls: string[] = [];
      const runner: OrcaRunner = async (_command, args) => {
        calls.push(args.join(" "));
        return done;
      };
      expect(
        await updateBoard({ stage: "in-progress" }, ORCA, runner, noConfig),
      ).toContain(
        `⚠ could not ask Orca which worktree this is (exit ${done.code})`,
      );
      expect(calls).toEqual(["worktree current --json"]);
    }
  });

  test("warns when the update prints success but exits non-zero", async () => {
    const runner: OrcaRunner = async (_command, args) =>
      args[1] === "current"
        ? { code: 0, stdout: current, stderr: "" }
        : { code: 124, stdout: set, stderr: "" };
    expect(
      await updateBoard({ unread: true }, ORCA, runner, noConfig),
    ).toContain("⚠ could not update the card (exit 124)");
  });

  test("only warns when Orca refuses the update", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("--workspace-status", "shipping")]: JSON.stringify({
        ok: false,
        error: { code: "unknown_status" },
      }),
    });
    const config = () => ({ orca: { board: { completed: "shipping" } } });
    expect(
      await updateBoard({ stage: "completed" }, ORCA, runner, config),
    ).toContain("⚠ could not update the card (exit 1)");
  });
});

describe("orca.board", () => {
  test("defaults every stage to Orca's column of the same name", () => {
    expect(boardColumns({})).toEqual({
      ok: true,
      columns: {
        "in-progress": "in-progress",
        "in-review": "in-review",
        completed: "completed",
      },
    });
    expect(boardColumns({ orca: { board: null } })).toEqual(boardColumns({}));
  });

  test("maps the stages it names and keeps the rest", () => {
    expect(
      boardColumns({
        orca: { board: { in_progress: "doing", completed: "done" } },
      }),
    ).toEqual({
      ok: true,
      columns: {
        "in-progress": "doing",
        "in-review": "in-review",
        completed: "done",
      },
    });
  });

  test("refuses an unknown stage or a value that is not a status id", () => {
    for (const board of [
      { in_review: "" },
      { in_review: 3 },
      { in_review: "In Review" },
      { "in-review": "review" },
    ])
      expect(boardColumns({ orca: { board } })).toEqual({
        ok: false,
        problem: expect.stringMatching(/^orca\.board/),
      });
    expect(boardColumns({ orca: "board" })).toEqual({
      ok: false,
      problem: "orca must be a mapping",
    });
  });
});

describe("the command line", () => {
  test("takes a stage, a pull request, the unread mark and a comment", () => {
    expect(parseArgs(["in-progress"])).toEqual({ stage: "in-progress" });
    expect(parseArgs(["in-review", "--pr", "7"])).toEqual({
      stage: "in-review",
      pr: "7",
    });
    expect(parseArgs(["--unread", "--comment", "PR #7 parked: why?"])).toEqual({
      unread: true,
      comment: "PR #7 parked: why?",
    });
    expect(
      parseArgs(["--comment", "merged", "completed", "--pr", "7"]),
    ).toEqual({ stage: "completed", comment: "merged", pr: "7" });
    for (const stage of BOARD_STAGES)
      expect(parseArgs([stage])).toEqual({ stage });
  });

  test("refuses anything else", () => {
    for (const args of [
      [],
      ["--pr", "7"],
      ["In Review"],
      ["todo"],
      ["in-review", "completed"],
      ["in-review", "--pr"],
      ["in-review", "--pr", "x7"],
      ["in-review", "--issue", "7"],
      ["in-review", "--pr", "7", "extra"],
      ["--unread", "--unread"],
      ["--comment"],
      ["--comment", ""],
      ["--comment", "--unread"],
    ])
      expect(() => parseArgs(args)).toThrow(ExitError);
  });
});
