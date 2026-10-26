/**
 * Opening Orca worktree workspaces: creating, reattaching, the create hook
 * and a paired server, against the table in table.ts. The agent's start,
 * and the receipts that record it, are in kickoff.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import { openWorkspace } from "../workspace.ts";
import {
  absent,
  answer,
  B,
  CLAIM,
  claimHeld,
  commonDir,
  create,
  fetchBase,
  fetchBranch,
  fresh,
  gitList,
  held,
  HOOK,
  ID,
  inspect,
  isFile,
  launch,
  link,
  list,
  localRef,
  lsRemote,
  MARK,
  markWrite,
  onBox,
  options,
  ORCA_BRANCH,
  orcaError,
  porcelain,
  R,
  receiptOf,
  releaseClaim,
  remoteRef,
  rename,
  RID,
  row,
  takeClaim,
  testHook,
  TOK,
  workspaceOf,
  writeReceiptFile,
  WT,
} from "./table.ts";

describe("a branch no checkout holds", () => {
  test("is created through Orca from the refreshed base, renamed, and its agent started once", () => {
    const ws = workspaceOf(fresh);
    const opened = openWorkspace(ws, options);
    expect(opened).toEqual({
      path: WT,
      branch: B,
      worktreeId: ID,
      reattached: false,
      hookRan: false,
      agentLaunched: true,
      kickoff: "sent",
    });
    const calls = ws.ctx.calls;
    expect(calls.indexOf(fetchBase)).toBeLessThan(
      calls.indexOf(create("origin/main")),
    );
    expect(calls.indexOf(create("origin/main"))).toBeLessThan(
      calls.indexOf(rename),
    );
    expect(calls.indexOf(rename)).toBeLessThan(calls.indexOf(launch));
    expect(ws.ctx.lines.some((l) => l.includes("could not link ENG-1"))).toBe(
      true,
    );
    const receipt = JSON.parse(readFileSync(receiptOf(ws), "utf8"));
    expect(receipt).toMatchObject({
      key: "ENG-1",
      status: "sent",
      repoId: RID,
      worktreeId: ID,
      worktreeToken: TOK,
      agent: "claude",
      environment: null,
    });
    expect(receipt.owner).toBeUndefined();
    // Opening it again reattaches and does not start the agent a second time.
    const again = workspaceOf(held);
    writeReceiptFile(receiptOf(again), receipt);
    const reopened = openWorkspace(again, options);
    expect(reopened).toMatchObject({
      reattached: true,
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(
      again.ctx.calls.some((c) => c.startsWith("orca worktree create")),
    ).toBe(false);
    expect(again.ctx.calls.some((c) => c.startsWith("orca agent launch"))).toBe(
      false,
    );
  });

  test("that origin has is created from origin's copy and set to track it", () => {
    const ws = workspaceOf({
      ...fresh,
      [lsRemote]: ok(`abc\trefs/heads/${B}`),
      [fetchBranch]: ok(),
      [remoteRef]: ok("abc\n"),
      [create(`origin/${B}`)]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} checkout --quiet -B ${B} origin/${B}`]: ok(),
      [`git -C ${WT} branch -D ${ORCA_BRANCH}`]: ok(),
      [`git -C ${R} branch --set-upstream-to origin/${B} ${B}`]: ok(),
    });
    expect(openWorkspace(ws, options)).toMatchObject({ reattached: false });
    expect(ws.ctx.calls).toContain(create(`origin/${B}`));
    expect(ws.ctx.calls).toContain(
      `git -C ${R} branch --set-upstream-to origin/${B} ${B}`,
    );
    expect(ws.ctx.calls).not.toContain(fetchBase);
  });

  test("that only this clone has is checked out as it is", () => {
    const ws = workspaceOf({
      ...fresh,
      [localRef]: ok(),
      [create(B)]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} checkout --quiet ${B}`]: ok(),
      [`git -C ${WT} branch -D ${ORCA_BRANCH}`]: ok(),
    });
    openWorkspace(ws, options);
    expect(ws.ctx.calls).toContain(create(B));
    expect(ws.ctx.calls).toContain(`git -C ${WT} checkout --quiet ${B}`);
  });

  test("whose local copy holds commits origin lacks is refused before anything is created", () => {
    const ws = workspaceOf({
      ...fresh,
      [lsRemote]: ok(`abc\trefs/heads/${B}`),
      [fetchBranch]: ok(),
      [remoteRef]: ok("abc\n"),
      [localRef]: ok(),
      [`git -C ${R} rev-list origin/${B}..${B}`]: ok("def\n"),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "1 commit(s) origin lacks",
    );
    expect(ws.ctx.calls.some((c) => c.startsWith("orca worktree create"))).toBe(
      false,
    );
  });

  test("keeps the branch git reports when it is already the one asked for", () => {
    const ws = workspaceOf({
      ...fresh,
      // Orca's answer names a branch; what git has checked out is what counts.
      [create("origin/main")]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} symbolic-ref --short HEAD`]: ok(`${B}\n`),
    });
    openWorkspace(ws, options);
    expect(ws.ctx.calls.some((c) => c.includes(" branch -m "))).toBe(false);
  });

  test("whose creation left no branch checked out is refused", () => {
    const ws = workspaceOf({
      ...fresh,
      [`git -C ${WT} symbolic-ref --short HEAD`]: fail(
        128,
        "ref HEAD is not a symbolic ref",
      ),
    });
    expect(() => openWorkspace(ws, options)).toThrow("no branch checked out");
  });

  test("whose creation Orca reports in another clone is refused before any branch is touched", () => {
    const ws = workspaceOf({
      ...fresh,
      [commonDir(WT)]: ok("/other/.git\n"),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "belongs to the clone at /other/.git, not to /repo's",
    );
    expect(ws.ctx.calls).not.toContain(rename);
    expect(ws.ctx.calls.some((c) => c.includes(" checkout "))).toBe(false);
  });

  test("lists a detached checkout of the clone without a branch", () => {
    const ws = workspaceOf({
      ...held,
      [list]: answer({
        worktrees: [{ id: `${RID}::${R}`, path: R, branch: null }, row(B)],
      }),
    });
    expect(openWorkspace(ws, options)).toMatchObject({ reattached: true });
  });

  test("whose creation Orca reports somewhere git does not list is refused", () => {
    const ws = workspaceOf({
      ...fresh,
      [gitList]: porcelain([[R, "main"]]),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "git worktree list has nothing",
    );
  });
});

describe("the repository's create hook", () => {
  const hooked: Record<string, Answer> = {
    ...fresh,
    [testHook]: ok(),
    [inspect(MARK)]: absent,
    [takeClaim]: ok(),
    [HOOK]: ok("installed\n"),
    [markWrite]: ok(),
    [releaseClaim]: ok(),
  };

  test("runs once in the new worktree under a claim, before the agent starts, and leaves a mark", () => {
    const ws = workspaceOf(hooked);
    const opened = openWorkspace(ws, options);
    expect(opened.hookRan).toBe(true);
    const calls = ws.ctx.calls;
    const at = calls.indexOf(HOOK);
    expect(ws.ctx.options[at]?.cwd).toBe(WT);
    expect(calls.indexOf(takeClaim)).toBeLessThan(at);
    expect(at).toBeLessThan(calls.indexOf(markWrite));
    expect(calls.indexOf(markWrite)).toBeLessThan(calls.indexOf(releaseClaim));
    expect(calls.indexOf(releaseClaim)).toBeLessThan(calls.indexOf(launch));
    expect(ws.ctx.lines).toContain("installed");
  });

  test("is not run again where its mark is", () => {
    const ws = workspaceOf({ ...hooked, [inspect(MARK)]: isFile });
    expect(openWorkspace(ws, options).hookRan).toBe(false);
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).not.toContain(takeClaim);
  });

  test("that fails stops the open before the agent starts, gives the claim back, and leaves no mark or receipt", () => {
    const ws = workspaceOf({ ...hooked, [HOOK]: fail(3, "no network") });
    expect(() => openWorkspace(ws, options)).toThrow(
      `${HOOK} failed (exit 3); fix the hook and open the workspace again`,
    );
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.calls).not.toContain(markWrite);
    expect(ws.ctx.calls).toContain(releaseClaim);
    expect(existsSync(receiptOf(ws))).toBe(false);
  });

  test("that another open is running is waited for, and not run again once its mark appears", () => {
    // Whether the claim is held is read from mkdir's own reason: by the
    // time a second look at the claim would be taken, the other open may
    // have left its mark and given the claim back, and the next turn of the
    // wait is what reads the mark.
    const ws = workspaceOf({
      ...hooked,
      [inspect(MARK)]: [absent, isFile],
      [takeClaim]: claimHeld,
    });
    expect(openWorkspace(ws, options)).toMatchObject({
      hookRan: false,
      agentLaunched: true,
    });
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).not.toContain(inspect(CLAIM));
    expect(ws.ctx.slept).toEqual([1000]);
    expect(
      ws.ctx.lines.some((l) => l.includes("which another open is running")),
    ).toBe(true);
  });

  test("whose run another open waited for ended without a mark stops that open", () => {
    // The claim comes free with no mark under it: the run failed. The open
    // gives the claim back rather than running the hook over the failure.
    const ws = workspaceOf({
      ...hooked,
      [takeClaim]: [claimHeld, ok()],
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "ended without leaving its mark, so it failed",
    );
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.calls).toContain(releaseClaim);
    expect(ws.ctx.slept).toEqual([1000]);
  });

  test("is not run again when its mark appears as this open takes the claim", () => {
    // Another open wrote the mark and gave the claim back between this
    // open's look at the mark and its claim.
    const ws = workspaceOf({
      ...hooked,
      [inspect(MARK)]: [absent, isFile],
    });
    expect(openWorkspace(ws, options)).toMatchObject({
      hookRan: false,
      agentLaunched: true,
    });
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).toContain(takeClaim);
    expect(ws.ctx.calls).toContain(releaseClaim);
  });

  test("that another open finishes as this open's wait ends is not reported as failed", () => {
    // The mark is absent at the look before the claim, present under it.
    const ws = workspaceOf({
      ...hooked,
      [inspect(MARK)]: [absent, absent, isFile],
      [takeClaim]: [claimHeld, ok()],
    });
    expect(openWorkspace(ws, options)).toMatchObject({
      hookRan: false,
      agentLaunched: true,
    });
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).toContain(releaseClaim);
    expect(ws.ctx.slept).toEqual([1000]);
  });

  test("that another open holds past the hook's limit stops the wait and names the claim", () => {
    const ws = workspaceOf({
      ...hooked,
      [takeClaim]: fail(1, `mkdir: ${CLAIM}: File exists\n`),
    });
    // No time left for the wait: the deadline is now.
    ws.host = { ...ws.ctx, budget: () => 0 };
    expect(() => openWorkspace(ws, options)).toThrow(
      `if no process is still running it, remove ${CLAIM}`,
    );
    expect(ws.ctx.calls).not.toContain(HOOK);
  });

  test("whose claim cannot be taken for a reason other than another open holding it stops the open with that reason", () => {
    const ws = workspaceOf({
      ...hooked,
      [takeClaim]: fail(
        1,
        `mkdir: cannot create directory '${CLAIM}': Permission denied\n`,
      ),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      `could not take the create hook's claim ${CLAIM}`,
    );
    expect(ws.ctx.calls).not.toContain(inspect(CLAIM));
    expect(ws.ctx.calls).not.toContain(HOOK);
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.slept).toEqual([]);
  });
});

describe("a branch a checkout already holds", () => {
  test("is reattached, its upstream checked, the issue linked, and its agent started when no open started one", () => {
    const ws = workspaceOf(held);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.calls).toContain(fetchBranch);
    expect(ws.ctx.calls).toContain(link);
  });

  test("that Orca does not list is refused rather than duplicated", () => {
    const ws = workspaceOf({ ...held, [list]: answer({ worktrees: [] }) });
    expect(() => openWorkspace(ws, options)).toThrow(
      "which Orca does not list",
    );
  });

  test("is opened on the one existing branch its reuse prefix finds", () => {
    const reuse = { ...options, branch: "feat/x-new", reusePrefix: "feat/x" };
    const ws = workspaceOf({
      ...held,
      "git check-ref-format --branch feat/x-new": ok(),
      [`git -C ${R} for-each-ref --format=%(refname) refs/heads/`]: ok(
        `refs/heads/main\nrefs/heads/${B}\n`,
      ),
      [`git -C ${R} ls-remote --heads origin`]: ok(""),
    });
    expect(openWorkspace(ws, reuse).branch).toBe(B);
  });

  test("with --no-agent is opened without starting anything", () => {
    const ws = workspaceOf(held);
    expect(openWorkspace(ws, { ...options, noAgent: true })).toMatchObject({
      agentLaunched: false,
      kickoff: "none",
    });
    expect(ws.ctx.calls).not.toContain(launch);
    expect(existsSync(receiptOf(ws))).toBe(false);
  });
});

describe("a paired server", () => {
  test("is named on every Orca call, and its receipts are kept apart", () => {
    const ws = workspaceOf(onBox(fresh), "box", "box");
    openWorkspace(ws, options);
    for (const call of ws.ctx.calls.filter((c) => c.startsWith("orca ")))
      expect(call.endsWith(" --environment box --json")).toBe(true);
    expect(receiptOf(ws)).toBe(
      join(
        ws.ctx.stateDir,
        "kickoff",
        "server",
        "box",
        RID,
        "ENG-1.claude.json",
      ),
    );
    expect(JSON.parse(readFileSync(receiptOf(ws), "utf8")).environment).toBe(
      "box",
    );
  });

  test("names a repository Orca does not have there", () => {
    const ws = workspaceOf(
      {
        [`git check-ref-format --branch ${B}`]: ok(),
        "orca repo show --repo name:app --environment box --json":
          orcaError("repo_not_found"),
      },
      "box",
      "box",
    );
    expect(() => openWorkspace(ws, options)).toThrow(
      "Orca on box has no repository named app",
    );
  });
});
