import { describe, expect, test } from "bun:test";
import { ExitError } from "../cli.ts";
import {
  type OrcaRunner,
  orcaCommand,
  parseArgs,
  updateBoard,
} from "../orca-board.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const ID = "repo-1::/ws/app/feat-x";

/** A runner answering Orca's calls from a table keyed on the arguments; records every call. */
function orcaAnswering(answers: Record<string, string>) {
  const calls: string[] = [];
  const runner: OrcaRunner = async (command, args) => {
    const key = args.join(" ");
    calls.push(`${command} ${key}`);
    const stdout = answers[key];
    if (stdout === undefined) throw new Error(`unexpected call: ${key}`);
    return { code: stdout.includes('"ok":true') ? 0 : 1, stdout, stderr: "" };
  };
  return { calls, runner };
}

const current = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const set = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });
const setArgs = (status: string, pr?: string) =>
  [
    "worktree set --worktree",
    `id:${ID}`,
    "--workspace-status",
    status,
    ...(pr === undefined ? [] : ["--pr", pr]),
    "--json",
  ].join(" ");

describe("outside Orca", () => {
  test("makes no call at all", async () => {
    const { calls, runner } = orcaAnswering({});
    expect(await updateBoard({ status: "in-review" }, {}, runner)).toBe(
      "orca-board: not in Orca; nothing to do",
    );
    expect(calls).toEqual([]);
  });

  test("Orca's command comes from its terminal's environment only", () => {
    expect(orcaCommand({})).toBeNull();
    expect(orcaCommand({ ORCA_CLI_BIN_DIR: "/opt/orca/bin" })).toBe(
      "/opt/orca/bin/orca",
    );
    expect(orcaCommand({ ...ORCA, ORCA_CLI_BIN_DIR: "/elsewhere" })).toBe(
      "/opt/orca/bin/orca",
    );
  });
});

describe("in an Orca terminal", () => {
  test("sets the working directory's card and links the pull request", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("in-review", "42")]: set,
    });
    expect(
      await updateBoard({ status: "in-review", pr: "42" }, ORCA, runner),
    ).toBe("orca-board: in-review, PR #42 linked");
    expect(calls).toEqual([
      "/opt/orca/bin/orca worktree current --json",
      `/opt/orca/bin/orca ${setArgs("in-review", "42")}`,
    ]);
  });

  test("leaves a directory Orca does not list alone", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": JSON.stringify({
        ok: false,
        error: { code: "worktree_not_found" },
      }),
    });
    expect(
      await updateBoard({ status: "in-progress" }, ORCA, runner),
    ).toContain("does not list this directory");
    expect(calls).toHaveLength(1);
  });

  test("only warns when Orca refuses the update", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current,
      [setArgs("shipping")]: JSON.stringify({
        ok: false,
        error: { code: "unknown_status" },
      }),
    });
    expect(await updateBoard({ status: "shipping" }, ORCA, runner)).toContain(
      "⚠ could not set the board status (exit 1)",
    );
  });
});

describe("the command line", () => {
  test("takes a status and an optional pull request number", () => {
    expect(parseArgs(["in-progress"])).toEqual({ status: "in-progress" });
    expect(parseArgs(["in-review", "--pr", "7"])).toEqual({
      status: "in-review",
      pr: "7",
    });
  });

  test("refuses anything else", () => {
    for (const args of [
      [],
      ["In Review"],
      ["in-review", "--pr"],
      ["in-review", "--pr", "x7"],
      ["in-review", "--issue", "7"],
      ["in-review", "--pr", "7", "extra"],
    ])
      expect(() => parseArgs(args)).toThrow(ExitError);
  });
});
