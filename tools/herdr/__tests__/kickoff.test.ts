import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  acquireClaim,
  type KickoffOptions,
  kickoff,
  promptToken,
  receiptDir,
  reconcileKickoff,
  releaseClaim,
  transcriptHasToken,
} from "../kickoff.ts";
import type { Spawned } from "../spawn.ts";
import {
  type Answer,
  type FakeContext,
  fail,
  fakeContext,
  herdrError,
  ok,
  result,
} from "./fake.ts";

const A = "feat-x-12345678";
const KEY = "ABC-1";
const PROMPT = "/jig:do-item ABC-1\nLauncher context: /c/ABC-1.json";
const get = `herdr agent get ${A}`;
const read = `herdr agent read ${A} --source recent --lines 4000`;
const send = `herdr agent prompt ${A} ${PROMPT}`;
const session = (value: string | null) =>
  result({ agent: value === null ? {} : { agent_session: { value } } });

const spawned = (fields: Partial<Spawned> = {}): Spawned => ({
  path: "/wt",
  reattached: false,
  workspaceId: "w1",
  agentName: A,
  agentStatus: "idle",
  agentStarted: true,
  agentExisted: false,
  agentResumed: false,
  agentSessionId: "s-1",
  agentSessionError: null,
  ...fields,
});

const options: KickoffOptions = {
  key: KEY,
  prompt: PROMPT,
  claimWaitMs: 0,
};

/** Write a receipt file as the launch of claim generation `generation`. */
function writeReceipt(
  ctx: FakeContext,
  agent: string,
  generation: string,
  line: string,
): void {
  const dir = receiptDir(ctx, KEY, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, generation), `${line}\n`);
}

/** The receipt in force for an agent: its highest-numbered file. */
function receiptOf(
  ctx: FakeContext,
  key: string,
  agent: string,
): string | null {
  const dir = receiptDir(ctx, key, agent);
  if (!existsSync(dir)) return null;
  const top = readdirSync(dir)
    .filter((name) => /^[0-9]+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b)
    .at(-1);
  return top === undefined
    ? null
    : readFileSync(join(dir, String(top)), "utf8");
}

/** The id of a process that has ended. */
function endedPid(): number {
  const ended = Bun.spawnSync(["true"]);
  expectSpawnExit(ended, 0, "true");
  return ended.pid;
}

/** A context with a receipt from an earlier launch (generation 0). */
function withReceipt(table: Record<string, Answer>, line: string | null) {
  const ctx = fakeContext(table);
  if (line !== null) writeReceipt(ctx, A, "0", line);
  return ctx;
}

describe("the transcript token", () => {
  test("is the prompt's first line, matched as itself", () => {
    expect(promptToken(PROMPT)).toBe("/jig:do-item ABC-1");
    expect(
      transcriptHasToken("> /jig:do-item ABC-1\n", "/jig:do-item ABC-1"),
    ).toBe(true);
    expect(
      transcriptHasToken("> /jig:do-item ABC-10\n", "/jig:do-item ABC-1"),
    ).toBe(false);
    expect(
      transcriptHasToken("> /jig:do-item ABC-1-x\n", "/jig:do-item ABC-1"),
    ).toBe(false);
    expect(
      transcriptHasToken("> /jig:do-item ABC-1.2\n", "/jig:do-item ABC-1"),
    ).toBe(false);
    expect(
      transcriptHasToken("ran /jig:do-item ABC-1.\n", "/jig:do-item ABC-1"),
    ).toBe(true);
    expect(transcriptHasToken("", "")).toBe(false);
  });
  test("a key that cannot name a file is refused", () => {
    expect(() => receiptDir(fakeContext({}), "../x", A)).toThrow(
      "cannot be a kickoff key",
    );
  });
});

describe("reconcileKickoff", () => {
  test("a receipt for this session: delivered, without reading the transcript", () => {
    const ctx = withReceipt({ [get]: session("s-1") }, `${KEY}:${A}:s-1`);
    expect(reconcileKickoff(ctx, A, KEY, PROMPT).verdict).toBe("delivered");
    expect(ctx.calls).not.toContain(read);
  });
  test("a receipt for another session of this agent: undelivered, without the transcript", () => {
    for (const line of [
      `${KEY}:${A}:s-0`,
      `${KEY}:${A}`,
      `pending ${KEY}:${A}:s-0`,
    ]) {
      const ctx = withReceipt({ [get]: session("s-1") }, line);
      expect(reconcileKickoff(ctx, A, KEY, PROMPT).verdict).toBe("undelivered");
      expect(ctx.calls).not.toContain(read);
    }
  });
  test("no receipt: the transcript decides", () => {
    const seen = withReceipt(
      { [get]: session(null), [read]: ok("❯ /jig:do-item ABC-1\n") },
      null,
    );
    expect(reconcileKickoff(seen, A, KEY, PROMPT).verdict).toBe("delivered");
    const unseen = withReceipt(
      { [get]: session(null), [read]: ok("❯ hello\n") },
      null,
    );
    expect(reconcileKickoff(unseen, A, KEY, PROMPT).verdict).toBe(
      "undelivered",
    );
  });
  test("a pending receipt for this session: delivered only when the transcript shows it", () => {
    const pending = `pending ${KEY}:${A}:s-1`;
    const seen = withReceipt(
      { [get]: session("s-1"), [read]: ok("❯ /jig:do-item ABC-1\n") },
      pending,
    );
    expect(reconcileKickoff(seen, A, KEY, PROMPT).verdict).toBe("delivered");
    // Past the rows read, a delivered prompt is not shown: no answer either way.
    const unseen = withReceipt(
      { [get]: session("s-1"), [read]: ok("❯ later output\n") },
      pending,
    );
    expect(() => reconcileKickoff(unseen, A, KEY, PROMPT)).toThrow(
      "may have landed",
    );
  });
  test("a receipt this tool does not write is refused, not taken as none", () => {
    for (const line of [
      "",
      "pend",
      `pending ${KEY}`,
      `${KEY}:other-agent-1234:s-1`,
    ]) {
      const ctx = withReceipt(
        { [get]: session("s-1"), [read]: ok("❯ later output\n") },
        line,
      );
      expect(() => reconcileKickoff(ctx, A, KEY, PROMPT)).toThrow(
        "is not one this tool writes",
      );
      expect(ctx.calls).not.toContain(read);
    }
  });
  test("a session that changes during the check is an error", () => {
    const ctx = withReceipt(
      { [get]: [session("s-1"), session("s-2")] },
      `${KEY}:${A}:s-1`,
    );
    expect(() => reconcileKickoff(ctx, A, KEY, PROMPT)).toThrow(
      "changed from s-1 to s-2",
    );
  });
  test("a session that cannot be read, or a transcript that cannot, is an error", () => {
    expect(() =>
      reconcileKickoff(
        withReceipt({ [get]: fail(1, "down") }, null),
        A,
        KEY,
        PROMPT,
      ),
    ).toThrow("could not read the session");
    expect(() =>
      reconcileKickoff(
        withReceipt({ [get]: session(null), [read]: fail(1, "gone") }, null),
        A,
        KEY,
        PROMPT,
      ),
    ).toThrow("herdr agent read failed");
  });
});

describe("claims", () => {
  test("a live claim is waited for, then refused", () => {
    const ctx = fakeContext({});
    expect(acquireClaim(ctx, KEY, 0)).toBe("1");
    expect(() => acquireClaim(ctx, KEY, 0)).toThrow(
      "another launch is kicking off ABC-1",
    );
  });
  test("a claim whose owner has ended is taken over by the next generation, and the old one removed", () => {
    const ctx = fakeContext({});
    expect(acquireClaim(ctx, KEY, 0)).toBe("1");
    const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
    writeFileSync(join(dir, "1", "owner"), `${hostname()} ${endedPid()}\n`);
    expect(acquireClaim(ctx, KEY, 0)).toBe("2");
    expect(readdirSync(dir)).toEqual(["2"]);
    expect(readFileSync(join(dir, "2", "owner"), "utf8")).toBe(
      `${hostname()} ${process.pid}\n`,
    );
  });
  test("a claim whose owner still runs is never taken over, however old", () => {
    // A holder paused between its claim check and its send must not have a
    // second launch send beside it once it resumes.
    const ctx = fakeContext({});
    expect(acquireClaim(ctx, KEY, 0)).toBe("1");
    const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
    const old = new Date(Date.now() - 24 * 3_600_000);
    utimesSync(join(dir, "1"), old, old);
    utimesSync(join(dir, "1", "owner"), old, old);
    expect(() => acquireClaim(ctx, KEY, 0)).toThrow(
      "another launch is kicking off ABC-1 (claim 1)",
    );
    expect(readdirSync(dir)).toEqual(["1"]);
  });
  test("a claim owned on another host, or with no owner, is never taken over", () => {
    for (const owner of [`elsewhere.invalid ${endedPid()}\n`, null, "\n"]) {
      const ctx = fakeContext({});
      expect(acquireClaim(ctx, KEY, 0)).toBe("1");
      const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
      if (owner === null) rmSync(join(dir, "1", "owner"));
      else writeFileSync(join(dir, "1", "owner"), owner);
      expect(() => acquireClaim(ctx, KEY, 0)).toThrow(
        `remove ${join(dir, "1")}`,
      );
      expect(readdirSync(dir)).toEqual(["1"]);
    }
  });
  test("a holder releases only its own generation", () => {
    const ctx = fakeContext({});
    acquireClaim(ctx, KEY, 0);
    releaseClaim(ctx, KEY, "7");
    expect(existsSync(join(ctx.stateDir, "kickoff", "claims", KEY, "1"))).toBe(
      true,
    );
    releaseClaim(ctx, KEY, "1");
    expect(acquireClaim(ctx, KEY, 0)).toBe("2");
  });
  test("a released number is never taken again", () => {
    // A launch that read generation 1 as abandoned and paused must not be
    // able to create a number another launch holds after 1 was released.
    const ctx = fakeContext({});
    const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
    expect(acquireClaim(ctx, KEY, 0)).toBe("1");
    releaseClaim(ctx, KEY, "1");
    expect(acquireClaim(ctx, KEY, 0)).toBe("2");
    releaseClaim(ctx, KEY, "2");
    expect(acquireClaim(ctx, KEY, 0)).toBe("3");
    expect(readdirSync(dir)).toEqual(["3"]);
  });
});

describe("kickoff", () => {
  const claims = (ctx: { stateDir: string }) =>
    existsSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      ? readdirSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      : [];
  const receipt = (ctx: FakeContext) => receiptOf(ctx, KEY, A);

  test("a new agent is sent the prompt and the receipt written", () => {
    const ctx = fakeContext({ [get]: session("s-1"), [send]: ok() });
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(receipt(ctx)).toBe(`${KEY}:${A}:s-1\n`);
    expect(claims(ctx)).toEqual(["1"]);
  });

  test("the receipt is pending while the prompt is sent", () => {
    const ctx = fakeContext({
      [get]: session("s-1"),
      [send]: () => {
        expect(receipt(ctx)).toBe(`pending ${KEY}:${A}:s-1\n`);
        return ok();
      },
    });
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
  });

  test("a reattached agent that has it is not sent it again", () => {
    const ctx = withReceipt({ [get]: session("s-1") }, `${KEY}:${A}:s-1`);
    expect(
      kickoff(
        ctx,
        spawned({ agentExisted: true, agentStarted: false }),
        options,
      ),
    ).toBe("already-delivered");
    expect(ctx.calls).not.toContain(send);
  });

  test("an agent at a dialog is refused before anything is claimed or sent", () => {
    const ctx = fakeContext({});
    expect(() =>
      kickoff(ctx, spawned({ agentStatus: "blocked" }), options),
    ).toThrow("waiting at a dialog");
    expect(ctx.calls).toEqual([]);
  });

  test("an agent that resumed its session is checked like a running one", () => {
    const ctx = withReceipt({ [get]: session("s-1") }, `${KEY}:${A}:s-1`);
    expect(kickoff(ctx, spawned({ agentResumed: true }), options)).toBe(
      "already-delivered",
    );
    expect(ctx.calls).not.toContain(send);
  });

  test("a session that could not be read refuses the kickoff", () => {
    const ctx = fakeContext({});
    expect(() =>
      kickoff(
        ctx,
        spawned({ agentSessionId: null, agentSessionError: "socket closed" }),
        options,
      ),
    ).toThrow("could not read the session");
    expect(ctx.calls).toEqual([]);
  });

  test("an agent restarted while the claim was awaited is not sent to", () => {
    for (const fields of [{}, { agentExisted: true }]) {
      const ctx = withReceipt(
        { [get]: session("s-2"), [read]: ok("❯ hello\n") },
        `${KEY}:${A}:s-0`,
      );
      expect(() => kickoff(ctx, spawned(fields), options)).toThrow(
        "changed from s-1 to s-2",
      );
      expect(ctx.calls).not.toContain(send);
      expect(receipt(ctx)).toBe(`${KEY}:${A}:s-0\n`);
    }
  });

  test("the same key opened in another agent keeps each agent's receipt", () => {
    const B = "feat-x-87654321";
    const ctx = fakeContext({
      [get]: session("s-1"),
      [send]: ok(),
      [`herdr agent get ${B}`]: session("s-9"),
      [`herdr agent prompt ${B} ${PROMPT}`]: ok(),
    });
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(
      kickoff(ctx, spawned({ agentName: B, agentSessionId: "s-9" }), options),
    ).toBe("sent");
    // Back in the first agent, its own receipt answers, without the
    // transcript, whose earlier rows may be gone.
    expect(
      kickoff(
        ctx,
        spawned({ agentExisted: true, agentStarted: false }),
        options,
      ),
    ).toBe("already-delivered");
    expect(ctx.calls.some((call) => call.startsWith("herdr agent read"))).toBe(
      false,
    );
    expect(receiptOf(ctx, KEY, B)).toBe(`${KEY}:${B}:s-9\n`);
  });

  test("a send the run's time limit would cut short is refused before any record", () => {
    const ctx = { ...fakeContext({ [get]: session("s-1") }), budget: () => 1 };
    expect(() => kickoff(ctx, spawned(), options)).toThrow(
      "too little of the run's time limit",
    );
    expect(receipt(ctx)).toBe(null);
  });

  test("a prompt whose first line is empty is refused", () => {
    const ctx = fakeContext({});
    expect(() =>
      kickoff(ctx, spawned(), { ...options, prompt: "\n/jig:do-item ABC-1" }),
    ).toThrow("first line is empty");
  });

  test("a key named like the claims directory works", () => {
    const ctx = fakeContext({ [get]: session("s-1"), [send]: ok() });
    expect(kickoff(ctx, spawned(), { ...options, key: "claims" })).toBe("sent");
    expect(receiptOf(ctx, "claims", A)).toBe(`claims:${A}:s-1\n`);
  });

  test("a receipt that fails to be written after the send stays pending, and a later launch does not resend", () => {
    const ctx = withReceipt(
      {
        [get]: session("s-1"),
        // A directory takes the final receipt's temporary name once the
        // prompt is sent, which fails the write even for root.
        [send]: () => {
          mkdirSync(
            join(receiptDir(ctx, KEY, A), `.1.${process.pid}.tmp`, "x"),
            {
              recursive: true,
            },
          );
          return ok();
        },
        [read]: ok("❯ more output than the rows read\n"),
      },
      `${KEY}:${A}:s-0`,
    );
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(receipt(ctx)).toBe(`pending ${KEY}:${A}:s-1\n`);
    expect(ctx.lines.join("\n")).toContain("receipt stays pending");
    const sends = ctx.calls.filter((call) => call === send).length;
    expect(() =>
      kickoff(ctx, spawned({ agentExisted: true }), options),
    ).toThrow("may have landed");
    expect(ctx.calls.filter((call) => call === send).length).toBe(sends);
  });

  test("a claim another launch took over is found before any record is touched", () => {
    const ctx = withReceipt(
      {
        // While this launch checks, its claim is removed by hand and another
        // launch takes the next one.
        [get]: () => {
          mkdirSync(join(ctx.stateDir, "kickoff", "claims", KEY, "2"), {
            recursive: true,
          });
          return session("s-1");
        },
        [read]: ok("❯ hello\n"),
      },
      `${KEY}:${A}:s-0`,
    );
    expect(() =>
      kickoff(ctx, spawned({ agentExisted: true }), options),
    ).toThrow("another launch took over the kickoff claim");
    expect(ctx.calls).not.toContain(send);
    expect(receipt(ctx)).toBe(`${KEY}:${A}:s-0\n`);
  });

  test("a prompt Herdr refuses releases the claim and restores the earlier receipt", () => {
    for (const answer of [
      herdrError("agent_blocked", "agent is blocked"),
      herdrError("agent_not_found", "no such agent"),
      fail(2, "usage"),
    ]) {
      const ctx = withReceipt(
        { [get]: session("s-1"), [send]: answer },
        `${KEY}:${A}:s-0`,
      );
      expect(() => kickoff(ctx, spawned(), options)).toThrow(
        "did not take the kickoff",
      );
      expect(claims(ctx)).toEqual(["1"]);
      expect(
        existsSync(
          join(ctx.stateDir, "kickoff", "claims", KEY, "1", "released"),
        ),
      ).toBe(true);
      expect(receipt(ctx)).toBe(`${KEY}:${A}:s-0\n`);
    }
  });

  test("a refused prompt never restores the earlier receipt over another launch's", () => {
    // While this launch's send stalls, its claim is removed by hand and
    // another launch takes the next one, sends and records the kickoff; then
    // Herdr refuses this launch's prompt.
    const takeOver = (ctx: FakeContext, line: string) => {
      mkdirSync(join(ctx.stateDir, "kickoff", "claims", KEY, "2"));
      writeReceipt(ctx, A, "2", line);
    };
    for (const line of [`${KEY}:${A}:s-1`, `pending ${KEY}:${A}:s-1`]) {
      const ctx: FakeContext = withReceipt(
        {
          [get]: session("s-1"),
          [send]: () => {
            takeOver(ctx, line);
            return herdrError("agent_blocked", "agent is blocked");
          },
        },
        null,
      );
      expect(() => kickoff(ctx, spawned(), options)).toThrow(
        "did not take the kickoff",
      );
      expect(receipt(ctx)).toBe(`${line}\n`);
    }
  });

  test("a send that completes after another launch took over never replaces that launch's receipt", () => {
    // This launch records pending s-1 and stalls; its claim is removed by
    // hand, the agent restarts as s-2 and another launch takes the next
    // claim, sends to s-2 and completes its receipt; then this launch's send
    // succeeds.
    const ctx: FakeContext = fakeContext({
      [get]: [session("s-1"), session("s-2"), session("s-2")],
      [send]: () => {
        mkdirSync(join(ctx.stateDir, "kickoff", "claims", KEY, "2"));
        writeReceipt(ctx, A, "2", `${KEY}:${A}:s-2`);
        return ok();
      },
      [read]: ok("❯ hello\n"),
    });
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(receipt(ctx)).toBe(`${KEY}:${A}:s-2\n`);
    // So the next open finds s-2 delivered instead of prompting it again.
    expect(reconcileKickoff(ctx, A, KEY, PROMPT).verdict).toBe("delivered");
  });

  test("a launch whose claim is older than another launch's receipt does not send", () => {
    const ctx = fakeContext({ [get]: session("s-1"), [send]: ok() });
    writeReceipt(ctx, A, "5", `${KEY}:${A}:s-1`);
    expect(() => kickoff(ctx, spawned(), options)).toThrow(
      "this launch was superseded",
    );
    expect(ctx.calls).not.toContain(send);
    expect(receipt(ctx)).toBe(`${KEY}:${A}:s-1\n`);
  });

  test("a completed receipt removes the files of the launches it supersedes", () => {
    const ctx = withReceipt(
      { [get]: session("s-1"), [send]: ok() },
      `pending ${KEY}:${A}:s-0`,
    );
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(readdirSync(receiptDir(ctx, KEY, A))).toEqual(["1"]);
  });

  test("a prompt that may or may not have landed keeps the claim and the pending receipt", () => {
    for (const answer of [
      fail(-1, "spawn error: timed out"),
      herdrError("timeout", "timed out"),
      herdrError("agent_prompt_stalled", "no activity"),
    ]) {
      const ctx = fakeContext({ [get]: session("s-1"), [send]: answer });
      expect(() => kickoff(ctx, spawned(), options)).toThrow(
        "could not tell whether",
      );
      expect(claims(ctx)).toEqual(["1"]);
      expect(
        existsSync(
          join(ctx.stateDir, "kickoff", "claims", KEY, "1", "released"),
        ),
      ).toBe(false);
      expect(receipt(ctx)).toBe(`pending ${KEY}:${A}:s-1\n`);
    }
  });
});
