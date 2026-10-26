/**
 * Starting the agent once: the kickoff receipts an open takes, completes,
 * waits for and sets aside, where it creates the worktree and where it
 * reattaches to the checkout that holds the branch, against the table in
 * table.ts. Opening itself, the create hook and a paired server are in
 * workspace.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fail, ok } from "../../herdr/__tests__/fake.ts";
import { ownerLine } from "../../herdr/owner.ts";
import {
  fileSegment,
  type Receipt,
  receiptPath,
  replaceStale,
} from "../receipts.ts";
import { openWorkspace } from "../workspace.ts";
import {
  absent,
  answer,
  B,
  create,
  fresh,
  held,
  HOOK,
  ID,
  inspect,
  isFile,
  launch,
  link,
  MARK,
  markWrite,
  options,
  ORCA_BRANCH,
  orcaError,
  publishToken,
  receiptOf,
  releaseClaim,
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
} from "./table.ts";

/**
 * The owner line of an open that has ended: this process's id with a start
 * that is not its own, as when the system gave a dead open's id to the
 * process that runs on (owner.ts tells a process by its id and its start).
 */
const endedOwner = (): string => `${hostname()} ${process.pid} ended`;

describe("a branch no checkout holds, where the agent starts", () => {
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

  test("created again over a pending receipt another machine's open wrote leaves it for a person, whatever token it carries", () => {
    // Whether that open still runs cannot be told from here, so its receipt
    // is neither waited for nor set aside, even though it carries the token
    // of a worktree that is gone: a person looks first.
    const ws = workspaceOf(fresh);
    const file = receiptOf(ws);
    const pending = {
      ...sentReceipt(ID, "tok-0"),
      status: "pending",
      owner: "box 1 0",
    };
    writeReceiptFile(file, pending);
    expect(() => openWorkspace(ws, options)).toThrow("has no outcome recorded");
    expect(ws.ctx.calls).toContain(create("origin/main"));
    expect(ws.ctx.calls).not.toContain(launch);
    expect(retiredBeside(file)).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pending);
  });

  test("created again over a pending receipt of the worktree that stood here before, whose open has ended, sets it aside by its token and starts the agent", () => {
    // The launch in the old worktree was cut short, the worktree was removed
    // (which leaves receipts in place) and created again at the same path,
    // with the same id. The open that was starting the agent has ended and
    // the receipt carries the old worktree's token, so nothing it may have
    // started stands here: it is set aside like a completed receipt.
    const ws = workspaceOf(fresh);
    const file = receiptOf(ws);
    const pending: Receipt = {
      ...sentReceipt(ID, "tok-0"),
      status: "pending",
      owner: endedOwner(),
    };
    writeReceiptFile(file, pending);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: false,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.slept).toEqual([]);
    expect(retiredBeside(file)).toEqual([
      retiredAs(file, pending).slice(file.lastIndexOf("/") + 1),
    ]);
    expect(JSON.parse(readFileSync(retiredAs(file, pending), "utf8"))).toEqual(
      pending,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "sent",
      worktreeToken: TOK,
    });
    expect(
      ws.ctx.lines.some((l) =>
        l.includes(
          `in a worktree that stood at ${ID} before this one, with no outcome recorded; starting one in ${ID}`,
        ),
      ),
    ).toBe(true);
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

describe("a branch a checkout already holds, where the agent starts", () => {
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

  test("whose earlier start in this worktree was cut short by an open that has ended is refused too, until a person looks", () => {
    // The receipt carries this worktree's token: the agent may have started
    // here, and the open that would have recorded the outcome is gone.
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const pending: Receipt = {
      ...sentReceipt(),
      status: "pending",
      owner: endedOwner(),
    };
    writeReceiptFile(file, pending);
    expect(() => openWorkspace(ws, options)).toThrow("no outcome recorded");
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.slept).toEqual([]);
    expect(retiredBeside(file)).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pending);
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

  test("whose start another open is making in a worktree that no longer holds the branch is waited for, then set aside and made here", () => {
    // The other open still runs, so its receipt is not taken over by its
    // token: one open changes the file at a time. It completes the start
    // while this one waits, with its own worktree's token, and this open
    // then sets that completed receipt aside and starts the agent here.
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const elsewhere = sentReceipt(`${RID}::/ws/repo/elsewhere`, "tok-0");
    writeReceiptFile(file, {
      ...elsewhere,
      status: "pending",
      owner: ownerLine(ws.ctx).trim(),
    });
    ws.orca = {
      ...ws.ctx,
      sleep: (ms) => {
        ws.ctx.slept.push(ms);
        writeReceiptFile(file, elsewhere);
      },
    };
    expect(openWorkspace(ws, options)).toMatchObject({
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.slept).toEqual([1000]);
    expect(ws.ctx.calls).toContain(launch);
    expect(
      ws.ctx.lines.some((l) => l.includes("waiting for another open")),
    ).toBe(true);
    expect(retiredBeside(file)).toEqual([
      retiredAs(file, elsewhere).slice(file.lastIndexOf("/") + 1),
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "sent",
      worktreeId: ID,
      worktreeToken: TOK,
    });
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

  test("whose agent an open that has ended was starting in a worktree that no longer holds the branch gets one here", () => {
    const ws = workspaceOf(held);
    const file = receiptOf(ws);
    const elsewhere: Receipt = {
      ...sentReceipt(`${RID}::/ws/repo/elsewhere`, "tok-0"),
      status: "pending",
      owner: endedOwner(),
    };
    writeReceiptFile(file, elsewhere);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.slept).toEqual([]);
    expect(retiredBeside(file)).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(retiredAs(file, elsewhere), "utf8")),
    ).toEqual(elsewhere);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      status: "sent",
      worktreeId: ID,
      worktreeToken: TOK,
    });
    expect(
      ws.ctx.lines.some((l) =>
        l.includes(
          `an open that has since ended was starting ENG-1's agent on ${elsewhere.at} in ${elsewhere.worktreeId}, a worktree that no longer holds the branch, with no outcome recorded; starting one in ${ID}`,
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
});

describe("a stale receipt's replacement", () => {
  // What an open read before the link is a hint: judging the receipt's
  // owner takes a moment, and the link names whatever is at the file when
  // it is made. The linked copy is read again under the retired name, and
  // must be what was read.
  const read: Receipt = {
    ...sentReceipt(ID, "tok-0"),
    status: "pending",
    owner: endedOwner(),
  };
  const pendingOf = (ws: ReturnType<typeof workspaceOf>): Receipt => ({
    ...sentReceipt(),
    status: "pending",
    owner: ownerLine(ws.ctx).trim(),
    at: "2026-01-01T00:00:01Z",
  });

  test("is not made over a receipt created anew after the one read was cleared, and sends the open back to the file", () => {
    // The open that was starting the agent in the worktree that stood here
    // before had Orca refuse the start, cleared its receipt and ended; a
    // third open then created the receipt of a start in this worktree,
    // which it is still making. The link under the first receipt's retired
    // name catches the third's, which is not what was read: it is not set
    // aside, nothing is written over it, and the open reads the file again,
    // where it finds that start to wait for rather than making a second.
    const ws = workspaceOf({});
    const file = receiptOf(ws);
    const current: Receipt = {
      ...pendingOf(ws),
      at: "2026-01-01T00:00:02Z",
    };
    writeReceiptFile(file, current);
    expect(replaceStale(ws, file, read, pendingOf(ws))).toBe("changed");
    expect(readdirSync(dirname(file))).toEqual([basename(file)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(current);
    expect(ws.ctx.lines).toEqual([]);
  });

  test("is not made when the receipt read is gone, and sends the open back to the file", () => {
    // Its open had Orca refuse the start and cleared it: the next read
    // finds no receipt, and the open creates its own.
    const ws = workspaceOf({});
    const file = receiptOf(ws);
    mkdirSync(dirname(file), { recursive: true });
    expect(replaceStale(ws, file, read, pendingOf(ws))).toBe("changed");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dirname(file))).toEqual([]);
    expect(ws.ctx.lines).toEqual([]);
  });

  test("is made over the receipt read, set aside under its retired name, by the first open to link it", () => {
    const ws = workspaceOf({});
    const file = receiptOf(ws);
    writeReceiptFile(file, read);
    const pending = pendingOf(ws);
    expect(replaceStale(ws, file, read, pending)).toBe("replaced");
    expect(JSON.parse(readFileSync(retiredAs(file, read), "utf8"))).toEqual(
      read,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pending);
    expect(ws.ctx.lines).toHaveLength(1);
    // A second open that read the same receipt finds it set aside.
    expect(replaceStale(ws, file, read, pending)).toBe("taken");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pending);
    expect(ws.ctx.lines).toHaveLength(1);
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
