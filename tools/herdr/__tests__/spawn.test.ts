import { describe, expect, test } from "bun:test";
import { normalizeAgentName } from "../agent.ts";
import { type SpawnOptions, spawnWorkspace } from "../spawn.ts";
import type { RunResult } from "../runner.ts";
import {
  type Answer,
  fail,
  fakeContext,
  herdrError,
  ok,
  result,
} from "./fake.ts";

const R = "/repo";
const B = "feat/x";
const WT = "/wt/feat-x";
const A = normalizeAgentName(B, "/repo/.git");

const options: SpawnOptions = {
  repo: R,
  branch: B,
  base: "origin/main",
  kind: "claude",
  noAgent: false,
  waitTimeoutMs: 1000,
};

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

const herdrList = `herdr worktree list --cwd ${R} --json`;
const gitList = `git -C ${R} worktree list --porcelain -z`;
const fetchBranch = `git -C ${R} fetch --prune origin +refs/heads/${B}:refs/remotes/origin/${B}`;
const remoteRef = `git -C ${R} rev-parse --verify --quiet refs/remotes/origin/${B}`;
const get = `herdr agent get ${A}`;
const wait = `herdr agent wait ${A} --until idle --until blocked --until done --timeout 1000`;
const opened = (workspace: string, pane: string, alreadyOpen?: boolean) =>
  result({
    workspace: { workspace_id: workspace },
    root_pane: { pane_id: pane },
    worktree: { path: WT },
    ...(alreadyOpen === undefined ? {} : { already_open: alreadyOpen }),
  });

/** What every run asks: the name check, the clone's identity, and the checks of the worktree. */
const common: Record<string, Answer> = {
  [`git check-ref-format --branch ${B}`]: ok(B),
  [`git -C ${R} rev-parse --path-format=absolute --git-common-dir`]:
    ok("/repo/.git\n"),
  [`git -C ${WT} rev-parse --absolute-git-dir`]: ok(
    "/repo/.git/worktrees/feat-x\n",
  ),
  [`git -C ${WT} rev-parse --path-format=absolute --git-common-dir`]:
    ok("/repo/.git\n"),
  [fetchBranch]: fail(128, "couldn't find remote ref"),
  [`git -C ${R} update-ref -d refs/remotes/origin/${B}`]: ok(),
  [remoteRef]: fail(1),
};

const fresh: Record<string, Answer> = {
  ...common,
  [herdrList]: result({ worktrees: [] }),
  [gitList]: [
    porcelain([[R, "main"]]),
    porcelain([
      [R, "main"],
      [WT, B],
    ]),
  ],
  [`git -C ${R} ls-remote --exit-code --heads origin ${B}`]: fail(2),
  [`git -C ${R} show-ref --verify --quiet refs/heads/${B}`]: fail(1),
  [`git -C ${R} fetch --prune origin +refs/heads/main:refs/remotes/origin/main`]:
    ok(),
  [`herdr worktree create --cwd ${R} --branch ${B} --base origin/main --label ${B} --no-focus`]:
    opened("w1", "w1:p1"),
};

describe("a branch no checkout holds", () => {
  test("is created from the refreshed base and its agent started in the new pane", () => {
    const ctx = fakeContext({
      ...fresh,
      [`herdr agent start ${A} --kind claude --pane w1:p1`]: result({}),
      [wait]: result({ agent: { agent_status: "idle" } }),
      [get]: result({ agent: { agent_session: { value: "s-1" } } }),
    });
    expect(spawnWorkspace(ctx, options)).toEqual({
      path: WT,
      reattached: false,
      workspaceId: "w1",
      agentName: A,
      agentStatus: "idle",
      agentStarted: true,
      agentExisted: false,
      agentResumed: false,
      agentSessionId: "s-1",
      agentSessionError: null,
    });
  });

  test("with --no-agent no agent is started", () => {
    const ctx = fakeContext(fresh);
    expect(
      spawnWorkspace(ctx, { ...options, noAgent: true }).agentStarted,
    ).toBe(false);
    expect(ctx.calls.some((c) => c.startsWith("herdr agent"))).toBe(false);
  });

  test("a created path git does not confirm is refused", () => {
    const ctx = fakeContext({ ...fresh, [gitList]: porcelain([[R, "main"]]) });
    expect(() => spawnWorkspace(ctx, { ...options, noAgent: true })).toThrow(
      "the clone's git worktree list has nothing",
    );
  });
});

test("a local branch behind origin is moved to origin before Herdr checks it out", () => {
  const move = `git -C ${R} branch -f ${B} origin/${B}`;
  const ctx = fakeContext({
    ...fresh,
    [`git -C ${R} ls-remote --exit-code --heads origin ${B}`]: ok(),
    [fetchBranch]: ok(),
    [remoteRef]: ok(),
    [`git -C ${R} show-ref --verify --quiet refs/heads/${B}`]: ok(),
    [`git -C ${R} rev-list origin/${B}..${B}`]: ok(""),
    [move]: ok(),
    [`herdr worktree create --cwd ${R} --branch ${B} --base origin/${B} --label ${B} --no-focus`]:
      opened("w1", "w1:p1"),
    [`git -C ${R} branch --set-upstream-to origin/${B} ${B}`]: ok(),
  });
  spawnWorkspace(ctx, { ...options, noAgent: true });
  expect(ctx.calls.indexOf(move)).toBeLessThan(
    ctx.calls.findIndex((c) => c.startsWith("herdr worktree create")),
  );
});

test("a local branch ahead of origin is refused before anything is created", () => {
  const ctx = fakeContext({
    ...fresh,
    [`git -C ${R} ls-remote --exit-code --heads origin ${B}`]: ok(),
    [fetchBranch]: ok(),
    [remoteRef]: ok(),
    [`git -C ${R} show-ref --verify --quiet refs/heads/${B}`]: ok(),
    [`git -C ${R} rev-list origin/${B}..${B}`]: ok("c1\n"),
  });
  expect(() => spawnWorkspace(ctx, options)).toThrow(
    "1 commit(s) origin lacks",
  );
  expect(ctx.calls.some((c) => c.startsWith("herdr worktree create"))).toBe(
    false,
  );
});

describe("reattaching", () => {
  const known: Record<string, Answer> = {
    ...common,
    [herdrList]: result({
      worktrees: [{ branch: B, path: WT, open_workspace_id: "w1" }],
    }),
    [gitList]: porcelain([
      [R, "main"],
      [WT, B],
    ]),
    [`herdr worktree open --cwd ${R} --path ${WT} --label ${B} --no-focus`]:
      opened("w1", "w1:p1", true),
  };

  test("a live agent is waited for, never started again", () => {
    const ctx = fakeContext({
      ...known,
      [get]: result({
        agent: { agent_status: "idle", agent_session: { value: "s-9" } },
      }),
      [wait]: result({ agent: { agent_status: "idle" } }),
    });
    const spawned = spawnWorkspace(ctx, options);
    expect(spawned).toMatchObject({
      reattached: true,
      agentExisted: true,
      agentStarted: false,
      agentSessionId: "s-9",
    });
    expect(ctx.calls.some((c) => c.startsWith("herdr agent start"))).toBe(
      false,
    );
  });

  test("an open workspace without an agent gets the agent in a tab of its own", () => {
    const ctx = fakeContext({
      ...known,
      [get]: [herdrError("agent_not_found"), result({ agent: {} })],
      [`herdr tab create --workspace w1 --cwd ${WT} --label agent --no-focus`]:
        result({ root_pane: { pane_id: "w1:p7" } }),
      [`herdr agent start ${A} --kind claude --pane w1:p7`]: result({}),
      [wait]: result({ agent: { agent_status: "idle" } }),
    });
    expect(spawnWorkspace(ctx, options)).toMatchObject({
      reattached: true,
      agentStarted: true,
    });
  });

  test("a worktree created with plain git is opened in Herdr and used", () => {
    const ctx = fakeContext({
      ...known,
      [herdrList]: result({ worktrees: [] }),
      [`herdr worktree open --cwd ${R} --path ${WT} --label ${B} --no-focus`]:
        opened("w4", "w4:p1", false),
      [get]: [herdrError("agent_not_found"), result({ agent: {} })],
      [`herdr agent start ${A} --kind claude --pane w4:p1`]: result({}),
      [wait]: result({ agent: { agent_status: "idle" } }),
    });
    expect(spawnWorkspace(ctx, options)).toMatchObject({
      reattached: true,
      workspaceId: "w4",
      agentStarted: true,
    });
  });

  test("a reattach never reads origin/HEAD, which only a new branch needs", () => {
    const ctx = fakeContext({
      ...known,
      [get]: result({
        agent: { agent_status: "idle", agent_session: { value: "s-9" } },
      }),
      [wait]: result({ agent: { agent_status: "idle" } }),
    });
    const { base: _unused, ...withoutBase } = options;
    expect(spawnWorkspace(ctx, withoutBase).reattached).toBe(true);
    expect(ctx.calls.some((c) => c.includes("symbolic-ref"))).toBe(false);
  });

  test("a Herdr row git does not confirm is refused", () => {
    const ctx = fakeContext({ ...known, [gitList]: porcelain([[R, "main"]]) });
    expect(() => spawnWorkspace(ctx, options)).toThrow(
      "does not (it has nothing)",
    );
  });

  test("the primary checkout is never a reattach target", () => {
    const ctx = fakeContext({
      ...known,
      [herdrList]: result({ worktrees: [] }),
      [gitList]: porcelain([[R, B]]),
      [`git -C ${R} rev-parse --absolute-git-dir`]: ok("/repo/.git\n"),
    });
    expect(() => spawnWorkspace(ctx, options)).toThrow("primary checkout");
  });
});

test("an invalid branch name fails before anything is looked up", () => {
  const ctx = fakeContext({ "git check-ref-format --branch a..b": fail(1) });
  expect(() => spawnWorkspace(ctx, { ...options, branch: "a..b" })).toThrow(
    "not a valid branch name",
  );
  expect(ctx.calls).toHaveLength(1);
});
