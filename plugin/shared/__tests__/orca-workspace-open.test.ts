import { describe, expect, test } from "bun:test";
import { OrcaError, parseOrcaEnvelope } from "../orca-workspace/envelope.ts";
import {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
} from "../orca-workspace/hooks.ts";
import { openBranch } from "../orca-workspace/open.ts";
import { boundedHook, type OpenPort } from "../orca-workspace/port.ts";
import type { RunResult } from "../orca-workspace/runner.ts";
import { type Answer, fail, fakeContext, ok } from "./fake-context.ts";

const R = "/repo";
const B = "feat/x";
const WT = "/ws/repo/feat-x";
const RID = "rid";
const ID = `${RID}::${WT}`;
const GIT_DIR = "/repo/.git/worktrees/feat-x";
const HOOK = `${WT}/.config/worktree-hooks/create`;
const MARK = `${GIT_DIR}/${CREATE_HOOK_MARK}`;
const CLAIM = `${GIT_DIR}/${CREATE_HOOK_CLAIM}`;

const answer = (result: unknown): RunResult =>
  ok(JSON.stringify({ ok: true, result }));
const porcelain = (rows: [string, string][]): RunResult =>
  ok(
    rows
      .flatMap(([path, branch]) => [
        `worktree ${path}`,
        `branch refs/heads/${branch}`,
        "",
      ])
      .join("\0"),
  );
const row = (branch: string) => ({
  id: ID,
  path: WT,
  branch: `refs/heads/${branch}`,
});

/** A port whose git, hooks and Orca calls all answer from one table; an Orca call is keyed `orca <args>`. */
function portOf(table: Record<string, Answer>, where = "") {
  const ctx = fakeContext(table);
  const port: OpenPort = {
    host: ctx,
    runHook: boundedHook,
    orcaCall: <T>(args: string[], what: string) => {
      const envelope = parseOrcaEnvelope<T>(ctx.run(["orca", ...args]).stdout);
      if (envelope === null) throw new OrcaError(`${what}: unreadable`);
      return envelope;
    },
    where,
  };
  return { port, ctx };
}

const show = "orca repo show --repo name:app";
const gitList = `git -C ${R} worktree list --porcelain -z`;
const fetchBranch = `git -C ${R} fetch --prune origin +refs/heads/${B}:refs/remotes/origin/${B}`;
const remoteRef = `git -C ${R} rev-parse --verify --quiet refs/remotes/origin/${B}`;
const setUpstream = `git -C ${R} branch --set-upstream-to origin/${B} ${B}`;

const common: Record<string, Answer> = {
  [`git check-ref-format --branch ${B}`]: ok(B),
  [`git -C ${WT} rev-parse --absolute-git-dir`]: ok(`${GIT_DIR}\n`),
  [`git -C ${WT} rev-parse --path-format=absolute --git-common-dir`]:
    ok("/repo/.git\n"),
  [`git -C ${R} rev-parse --path-format=absolute --git-common-dir`]:
    ok("/repo/.git\n"),
  [fetchBranch]: ok(),
  [remoteRef]: ok(),
  [setUpstream]: ok(),
};

describe("openBranch", () => {
  test("checks a pull request's head branch out of origin in a new worktree and runs the create hook once", () => {
    const { port, ctx } = portOf({
      ...common,
      [gitList]: [
        porcelain([[R, "main"]]),
        porcelain([
          [R, "main"],
          [WT, B],
        ]),
      ],
      [`git -C ${R} ls-remote --exit-code --heads origin ${B}`]: ok(),
      [`git -C ${R} show-ref --verify --quiet refs/heads/${B}`]: fail(1),
      [`orca worktree create --repo id:${RID} --name ${B} --base-branch origin/${B} --no-parent --setup skip --comment PR 7 --pr 7`]:
        answer({ worktree: row("me/feat-x") }),
      [`git -C ${WT} symbolic-ref --short HEAD`]: ok("me/feat-x\n"),
      [`git -C ${WT} checkout --quiet -B ${B} origin/${B}`]: ok(),
      [`git -C ${WT} branch -D me/feat-x`]: ok(),
      [`test -x ${HOOK}`]: ok(),
      [`env LC_ALL=C ls -ldL -- ${MARK}`]: [
        fail(2, "ls: cannot access 'x': No such file or directory\n"),
      ],
      [`mkdir ${CLAIM}`]: ok(),
      [HOOK]: ok("installed\n"),
      [`sh -c printf ok > ${MARK}`]: ok(),
      [`rm -rf ${CLAIM}`]: ok(),
    });
    const opened = openBranch(port, {
      repo: { id: RID, path: R },
      branch: B,
      comment: "PR 7",
      createFlags: ["--pr", "7"],
    });
    expect(opened).toEqual({
      repo: { id: RID, path: R },
      worktree: { id: ID, path: WT, branch: B },
      reattached: false,
      hookRan: true,
    });
    expect(ctx.calls).not.toContain(show);
    expect(ctx.calls).toContain(setUpstream);
    expect(ctx.lines).toContain("installed");
  });

  test("reattaches to the checkout that holds the branch, resolving the repository by name", () => {
    const { port, ctx } = portOf({
      ...common,
      [show]: answer({
        repo: { id: RID, path: R },
      }),
      [gitList]: porcelain([
        [R, "main"],
        [WT, B],
      ]),
      [`orca worktree list --repo id:${RID}`]: answer({
        worktrees: [row(B)],
      }),
      [`test -x ${HOOK}`]: fail(1),
    });
    const opened = openBranch(port, { repo: "app", branch: B });
    expect(opened.reattached).toBe(true);
    expect(opened.hookRan).toBe(false);
    expect(ctx.lines).toContain(`↺ reattaching: ${B} is at ${WT}`);
  });

  test("names where Orca runs when it has no repository by the name", () => {
    const { port } = portOf(
      {
        ...common,
        [show]: ok(
          JSON.stringify({
            ok: false,
            error: { code: "repo_not_found", message: "no repo" },
          }),
        ),
      },
      " on server",
    );
    expect(() => openBranch(port, { repo: "app", branch: B })).toThrow(
      "Orca on server has no repository named app",
    );
  });
});
