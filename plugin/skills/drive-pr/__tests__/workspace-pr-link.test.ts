import { describe, expect, test } from "bun:test";
import { ExitError } from "../../../shared/cli.ts";
import { orcaAnswering } from "../../../../lib/test-helpers/orca-answering.ts";
import { linkWorkspacePr, parseArgs } from "../scripts/workspace-pr-link.ts";

const ORCA = { ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const ID = "repo-1::/ws/app/feat-x";

const current = (linkedPR: number | null) =>
  JSON.stringify({ ok: true, result: { worktree: { id: ID, linkedPR } } });
const SET = `worktree set --worktree id:${ID} --pr 42 --json`;
const set = JSON.stringify({ ok: true, result: { worktree: { id: ID } } });

describe("parseArgs", () => {
  test("takes one pull request number", () => {
    expect(parseArgs(["42"])).toBe("42");
  });
  test("refuses anything else", () => {
    for (const args of [[], ["x"], ["42", "43"]])
      expect(() => parseArgs(args)).toThrow(ExitError);
  });
});

describe("linkWorkspacePr", () => {
  test("makes no call outside Orca", async () => {
    const { calls, runner } = orcaAnswering({});
    expect(await linkWorkspacePr("42", {}, runner)).toBe(
      "workspace-pr-link: not in Orca; nothing to do",
    );
    expect(calls).toEqual([]);
  });

  test("leaves a workspace already pointing at the pull request", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": current(42),
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toBe(
      "workspace-pr-link: already linked to PR #42",
    );
    expect(calls).toEqual(["worktree current --json"]);
  });

  test("links a workspace with no link", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current(null),
      [SET]: set,
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toBe(
      "workspace-pr-link: linked to PR #42 (was no link)",
    );
  });

  test("corrects a link to another pull request", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current(7),
      [SET]: set,
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toBe(
      "workspace-pr-link: linked to PR #42 (was PR #7)",
    );
  });

  test("warns when the set fails", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": current(7),
      [SET]: JSON.stringify({ ok: false, error: { code: "boom" } }),
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toContain(
      "⚠ could not link the workspace to PR #42",
    );
  });

  test("leaves a directory Orca does not list alone", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": JSON.stringify({
        ok: false,
        error: { code: "selector_not_found" },
      }),
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toContain(
      "nothing to do",
    );
  });

  test("warns when another error only mentions the not-a-worktree code", async () => {
    const { runner } = orcaAnswering({
      "worktree current --json": JSON.stringify({
        ok: false,
        error: { code: "transport_error", message: "selector_not_found" },
      }),
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toContain(
      "⚠ could not ask Orca which worktree this is",
    );
  });

  test("warns, without setting, when the link is not a pull request number", async () => {
    const { calls, runner } = orcaAnswering({
      "worktree current --json": JSON.stringify({
        ok: true,
        result: { worktree: { id: ID, linkedPR: { toString: null } } },
      }),
    });
    expect(await linkWorkspacePr("42", ORCA, runner)).toBe(
      "workspace-pr-link: ⚠ Orca answered a link that is not a pull request number",
    );
    expect(calls).toEqual(["worktree current --json"]);
  });
});
