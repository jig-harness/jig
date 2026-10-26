/**
 * Opening Orca worktree workspaces: creating, reattaching, the create hook
 * and the agent's start, against the table in table.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import { ownerLine } from "../../herdr/owner.ts";
import { fileSegment, receiptPath } from "../receipts.ts";
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
  publishToken,
  R,
  receiptOf,
  releaseClaim,
  remoteRef,
  rename,
  retiredAs,
  retiredBeside,
  RID,
  row,
  sentReceipt,
  takeClaim,
  testHook,
  TOK,
  TOKEN,
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

  test("created again after its worktree went sets the old receipt aside by its token where the agent starts, and starts it anew", () => {
    // The worktree was removed in the Orca app, which set no receipt aside;
    // Orca gives the replacement the same path-derived id. Nothing is set
    // aside before the creation: the receipt is judged where the agent is
    // started, against the token the worktree standing then holds, which
    // this open publishes in the new git directory first.
    let file = "";
    const old = sentReceipt(ID, "tok-0");
    const ws = workspaceOf({
      ...fresh,
      [create("origin/main")]: () => {
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
        expect(retiredBeside(file)).toHaveLength(0);
        return answer({ worktree: row(ORCA_BRANCH) });
      },
    });
    file = receiptOf(ws);
    writeReceiptFile(file, old);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: false,
      agentLaunched: true,
      kickoff: "sent",
    });
    const calls = ws.ctx.calls;
    expect(calls.indexOf(publishToken)).toBeGreaterThan(
      calls.indexOf(create("origin/main")),
    );
    expect(calls.indexOf(publishToken)).toBeLessThan(calls.indexOf(launch));
    expect(retiredBeside(file)).toEqual([
      retiredAs(file, old).slice(file.lastIndexOf("/") + 1),
    ]);
    expect(JSON.parse(readFileSync(retiredAs(file, old), "utf8"))).toEqual(old);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "sent",
      worktreeToken: TOK,
    });
    expect(
      ws.ctx.lines.some((l) =>
        l.includes(`a worktree that stood at ${ID} before this one`),
      ),
    ).toBe(true);
  });

  test("whose creation fails after Orca made the worktree leaves the old receipt, which does not stand for the new worktree", () => {
    // The old worktree went in the Orca app, the replacement's create hook
    // fails, and the next open reattaches to a worktree with the old one's
    // id. The old receipt carries the old worktree's token and the new git
    // directory holds none, so the next open publishes one and starts the
    // agent; nothing had to happen before or after the creation for that.
    const file = receiptOf(workspaceOf({}));
    const stateDir = file.slice(0, file.indexOf("/kickoff/"));
    const old = sentReceipt(ID, "tok-0");
    writeReceiptFile(file, old);
    const failing = workspaceOf(
      {
        ...fresh,
        [testHook]: ok(),
        [inspect(MARK)]: absent,
        [takeClaim]: ok(),
        [HOOK]: fail(3, "no network"),
        [releaseClaim]: ok(),
      },
      undefined,
      undefined,
      stateDir,
    );
    expect(() => openWorkspace(failing, options)).toThrow(
      "fix the hook and open the workspace again",
    );
    expect(failing.ctx.calls).not.toContain(launch);
    expect(failing.ctx.calls).not.toContain(publishToken);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
    expect(retiredBeside(file)).toHaveLength(0);
    const next = workspaceOf(
      {
        ...held,
        [testHook]: ok(),
        [inspect(MARK)]: absent,
        [takeClaim]: ok(),
        [HOOK]: ok(),
        [markWrite]: ok(),
        [releaseClaim]: ok(),
        [inspect(TOKEN)]: absent,
        [publishToken]: ok(),
      },
      undefined,
      undefined,
      stateDir,
    );
    expect(openWorkspace(next, options)).toMatchObject({
      reattached: true,
      hookRan: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(next.ctx.calls).toContain(launch);
    expect(retiredBeside(file)).toEqual([
      retiredAs(file, old).slice(file.lastIndexOf("/") + 1),
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "sent",
      worktreeToken: TOK,
    });
  });

  test("created while another open reattached to it and started the agent does not start a second one", () => {
    // The other open finds the worktree once the branch has its name,
    // publishes the token and writes its receipt before this open, which
    // created the worktree, reaches its own: the link step is where the
    // table lets it happen.
    let file = "";
    const ws = workspaceOf({
      ...fresh,
      [link]: () => {
        writeReceiptFile(file, sentReceipt());
        return orcaError("linear_not_connected");
      },
      [inspect(TOKEN)]: isFile,
    });
    file = receiptOf(ws);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: false,
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.calls).not.toContain(publishToken);
    expect(retiredBeside(file)).toHaveLength(0);
    expect(ws.ctx.lines.some((l) => l.includes("not starting it again"))).toBe(
      true,
    );
  });

  test("whose worktree another open created and started the agent in after this open found none is left as that open made it", () => {
    // This open read the clone before the other open created the worktree
    // and wrote its receipt. Its own creation fails, since the branch is
    // taken, and the receipt is not touched: nothing is set aside before a
    // creation, so the next open reattaches and does not start a second
    // agent.
    const ws = workspaceOf({
      ...fresh,
      [create("origin/main")]: orcaError(
        "branch_exists",
        `${B} is checked out`,
      ),
    });
    const file = receiptOf(ws);
    const made = sentReceipt();
    writeReceiptFile(file, made);
    expect(() => openWorkspace(ws, options)).toThrow("orca worktree create");
    expect(ws.ctx.calls).not.toContain(launch);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(made);
    expect(retiredBeside(file)).toHaveLength(0);
    const next = workspaceOf(held, undefined, undefined, ws.ctx.stateDir);
    expect(openWorkspace(next, options)).toMatchObject({
      reattached: true,
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(next.ctx.calls).not.toContain(launch);
  });

  test("created again with --no-agent leaves the old receipt, which the next open with an agent sets aside by its token", () => {
    const ws = workspaceOf(fresh);
    const file = receiptOf(ws);
    const old = sentReceipt(ID, "tok-0");
    writeReceiptFile(file, old);
    expect(openWorkspace(ws, { ...options, noAgent: true })).toMatchObject({
      agentLaunched: false,
      kickoff: "none",
    });
    expect(ws.ctx.calls).not.toContain(publishToken);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
    expect(retiredBeside(file)).toHaveLength(0);
    const next = workspaceOf(
      { ...held, [inspect(TOKEN)]: absent, [publishToken]: ok() },
      undefined,
      undefined,
      ws.ctx.stateDir,
    );
    expect(openWorkspace(next, options)).toMatchObject({
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(retiredBeside(file)).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).worktreeToken).toBe(TOK);
  });

  test("created again over a pending receipt leaves it for the start to judge", () => {
    const ws = workspaceOf(fresh);
    const file = receiptOf(ws);
    const pending = { ...sentReceipt(), status: "pending", owner: "box 1 0" };
    writeReceiptFile(file, pending);
    expect(() => openWorkspace(ws, options)).toThrow("has no outcome recorded");
    expect(ws.ctx.calls).toContain(create("origin/main"));
    expect(ws.ctx.calls).not.toContain(launch);
    expect(retiredBeside(file)).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pending);
  });

  test("created again over a receipt of another launch at its path is refused where the agent starts, and nothing is started", () => {
    const ws = workspaceOf(fresh);
    const file = receiptOf(ws);
    const other = { ...sentReceipt(), agent: "codex" };
    writeReceiptFile(file, other);
    expect(() => openWorkspace(ws, options)).toThrow(
      "records the start of ENG-1's codex",
    );
    expect(ws.ctx.calls).not.toContain(launch);
    expect(retiredBeside(file)).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(other);
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

  test("whose earlier start was cut short is refused until a person looks", () => {
    const ws = workspaceOf(held);
    writeReceiptFile(receiptOf(ws), {
      ...sentReceipt(),
      status: "pending",
      owner: "elsewhere 1 0",
    });
    expect(() => openWorkspace(ws, options)).toThrow("no outcome recorded");
    expect(ws.ctx.calls).not.toContain(launch);
  });

  test("whose start another open is making is waited for, then not repeated", () => {
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    writeReceiptFile(file, {
      ...sentReceipt(),
      status: "pending",
      owner: ownerLine(ws.ctx).trim(),
    });
    // The other open answers while this one waits.
    ws.orca = {
      ...ws.ctx,
      sleep: (ms) => {
        ws.ctx.slept.push(ms);
        writeReceiptFile(file, sentReceipt());
      },
    };
    expect(openWorkspace(ws, options)).toMatchObject({
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.slept).toEqual([1000]);
    expect(
      ws.ctx.lines.some((l) => l.includes("waiting for another open")),
    ).toBe(true);
  });

  test("whose agent was started in a worktree that no longer holds the branch gets one here", () => {
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const elsewhere = sentReceipt(`${RID}::/ws/repo/elsewhere`, "tok-0");
    writeReceiptFile(file, elsewhere);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(retiredBeside(file)).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(retiredAs(file, elsewhere), "utf8")),
    ).toEqual(elsewhere);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      worktreeId: ID,
      worktreeToken: TOK,
    });
    expect(
      ws.ctx.lines.some((l) =>
        l.includes(
          `${elsewhere.worktreeId}, a worktree that no longer holds the branch`,
        ),
      ),
    ).toBe(true);
  });

  test("whose receipt for another agent names the worktree that stood at this path before gets that agent here", () => {
    // Both agents were started for the key, the worktree was deleted in the
    // Orca app and created again at the same path, with the same id, and
    // claude was started again there. codex's receipt still carries the old
    // worktree's token, which the new git directory does not hold, so it
    // does not stand, whatever its key or agent.
    const launchCodex = launch.replace("--agent claude", "--agent codex");
    const ws = workspaceOf({ ...held, [launchCodex]: answer({}) });
    const file = receiptOf(ws, "ENG-1", "codex");
    const old = { ...sentReceipt(ID, "tok-0"), agent: "codex" };
    writeReceiptFile(file, old);
    writeReceiptFile(receiptOf(ws), sentReceipt());
    expect(openWorkspace(ws, { ...options, agent: "codex" })).toMatchObject({
      reattached: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.calls).toContain(launchCodex);
    expect(retiredBeside(file)).toEqual([
      retiredAs(file, old).slice(file.lastIndexOf("/") + 1),
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      agent: "codex",
      status: "sent",
      worktreeToken: TOK,
    });
    expect(JSON.parse(readFileSync(receiptOf(ws), "utf8"))).toEqual(
      sentReceipt(),
    );
  });

  test("whose stale receipt another open is setting aside waits for that open's start, then does not repeat it", () => {
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const elsewhere = sentReceipt(`${RID}::/ws/repo/elsewhere`, "tok-0");
    writeReceiptFile(file, elsewhere);
    // The other open linked the stale receipt under its retired name and
    // has not replaced it yet; it finishes while this one waits.
    writeReceiptFile(retiredAs(file, elsewhere), elsewhere);
    ws.orca = {
      ...ws.ctx,
      sleep: (ms) => {
        ws.ctx.slept.push(ms);
        writeReceiptFile(file, sentReceipt());
      },
    };
    expect(openWorkspace(ws, options)).toMatchObject({
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.slept).toEqual([1000]);
    expect(retiredBeside(file)).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(sentReceipt());
    expect(
      ws.ctx.lines.some((l) => l.includes("setting aside the record")),
    ).toBe(true);
  });

  test("whose stale receipt another open set aside and never replaced stops, naming the copy to remove", () => {
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const elsewhere = sentReceipt(`${RID}::/ws/repo/elsewhere`, "tok-0");
    writeReceiptFile(file, elsewhere);
    writeReceiptFile(retiredAs(file, elsewhere), elsewhere);
    // No time left for the wait: the deadline is now.
    ws.orca = { ...ws.ctx, budget: () => 0 };
    expect(() => openWorkspace(ws, options)).toThrow(
      `remove ${retiredAs(file, elsewhere)} and open the workspace again`,
    );
    expect(ws.ctx.calls).not.toContain(launch);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(elsewhere);
  });

  test("whose receipt of the worktree that stood here before was set aside and never replaced stops too, naming the copy", () => {
    // Both names hold the old receipt: the open that set it aside ended
    // between the link and the replacement. The receipt names this
    // worktree's id but not its token, so the old start is not accepted;
    // the copy is named, as for any set-aside that was never finished.
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const old = sentReceipt(ID, "tok-0");
    writeReceiptFile(file, old);
    writeReceiptFile(retiredAs(file, old), old);
    ws.orca = { ...ws.ctx, budget: () => 0 };
    expect(() => openWorkspace(ws, options)).toThrow(
      `remove ${retiredAs(file, old)} and open the workspace again`,
    );
    expect(ws.ctx.calls).not.toContain(launch);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
  });

  test("with a receipt that is not whole is refused rather than read as a start", () => {
    const ws = workspaceOf(held);
    writeReceiptFile(receiptOf(ws), { status: "sent" });
    expect(() => openWorkspace(ws, options)).toThrow(
      "is not a kickoff receipt this tool wrote",
    );
    expect(ws.ctx.calls).not.toContain(launch);
  });

  test("with a receipt that records another launch at its path is refused", () => {
    const ws = workspaceOf(held);
    writeReceiptFile(receiptOf(ws), { ...sentReceipt(), agent: "codex" });
    expect(() => openWorkspace(ws, options)).toThrow(
      "records the start of ENG-1's codex",
    );
    expect(ws.ctx.calls).not.toContain(launch);
  });

  test("whose start Orca refuses is left with no receipt, so the next open tries again", () => {
    const ws = workspaceOf({
      ...held,
      [launch]: orcaError("agent_not_found", "no agent claude"),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "orca agent launch: no agent claude (agent_not_found); nothing was started",
    );
    expect(existsSync(receiptOf(ws))).toBe(false);
  });

  test("whose start got no answer keeps its pending receipt and its owner", () => {
    const ws = workspaceOf({
      ...held,
      [launch]: fail(1, "connection reset"),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "orca agent launch failed",
    );
    const receipt = JSON.parse(readFileSync(receiptOf(ws), "utf8"));
    expect(receipt.status).toBe("pending");
    expect(receipt.owner).toBe(ownerLine(ws.ctx).trim());
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

describe("a receipt", () => {
  test("is kept per Orca, repository and agent, under names that stay in their directory", () => {
    const ws = workspaceOf({});
    expect(receiptOf(ws)).toBe(
      join(ws.ctx.stateDir, "kickoff", "local", RID, "ENG-1.claude.json"),
    );
    expect(receiptOf(ws)).not.toBe(receiptPath(ws, "other", "ENG-1", "claude"));
    expect(receiptOf(ws)).not.toBe(receiptOf(ws, "ENG-1", "codex"));
    const server = workspaceOf({}, "local", "box");
    expect(receiptPath(server, RID, "ENG-1", "claude")).toBe(
      join(
        server.ctx.stateDir,
        "kickoff",
        "server",
        "local",
        RID,
        "ENG-1.claude.json",
      ),
    );
    expect(fileSegment("a/b c")).toBe("a%2Fb%20c");
    expect(fileSegment("x*y'(z)!~")).toBe("x%2Ay%27%28z%29%21%7E");
    expect(fileSegment("..")).toBe("%2E%2E");
    expect(fileSegment("rid-1.2_3")).toBe("rid-1%2E2_3");
    // A `.` in a key or an agent id never meets the `.` between them.
    expect(receiptOf(ws, "ENG-1.a", "b")).not.toBe(
      receiptOf(ws, "ENG-1", "a.b"),
    );
    expect(receiptOf(ws, "ENG-1.a", "b")).toBe(
      join(ws.ctx.stateDir, "kickoff", "local", RID, "ENG-1%2Ea.b.json"),
    );
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
