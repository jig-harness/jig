import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireClaim,
  type KickoffOptions,
  kickoff,
  promptToken,
  receiptPath,
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
  claimStaleMs: 60_000,
};

function withReceipt(table: Record<string, Answer>, line: string | null) {
  const ctx = fakeContext(table);
  if (line !== null) {
    mkdirSync(dirname(receiptPath(ctx, KEY)), { recursive: true });
    writeFileSync(receiptPath(ctx, KEY), `${line}\n`);
  }
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
    expect(() => receiptPath(fakeContext({}), "../x")).toThrow(
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
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("1");
    expect(() => acquireClaim(ctx, KEY, 0, 60_000)).toThrow(
      "another launch is kicking off ABC-1",
    );
  });
  test("an abandoned claim is taken over by the next generation, and the old one removed", () => {
    const ctx = fakeContext({});
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("1");
    const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(dir, "1"), old, old);
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("2");
    expect(readdirSync(dir)).toEqual(["2"]);
  });
  test("a holder releases only its own generation", () => {
    const ctx = fakeContext({});
    acquireClaim(ctx, KEY, 0, 60_000);
    releaseClaim(ctx, KEY, "7");
    expect(existsSync(join(ctx.stateDir, "kickoff", "claims", KEY, "1"))).toBe(
      true,
    );
    releaseClaim(ctx, KEY, "1");
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("2");
  });
  test("a released number is never taken again", () => {
    // A launch that read generation 1 as abandoned and paused must not be
    // able to create a number another launch holds after 1 was released.
    const ctx = fakeContext({});
    const dir = join(ctx.stateDir, "kickoff", "claims", KEY);
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("1");
    releaseClaim(ctx, KEY, "1");
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("2");
    releaseClaim(ctx, KEY, "2");
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("3");
    expect(readdirSync(dir)).toEqual(["3"]);
  });
});

describe("kickoff", () => {
  const claims = (ctx: { stateDir: string }) =>
    existsSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      ? readdirSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      : [];
  const receipt = (ctx: FakeContext) =>
    existsSync(receiptPath(ctx, KEY))
      ? readFileSync(receiptPath(ctx, KEY), "utf8")
      : null;

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

  test("a prompt whose first line is empty is refused", () => {
    const ctx = fakeContext({});
    expect(() =>
      kickoff(ctx, spawned(), { ...options, prompt: "\n/jig:do-item ABC-1" }),
    ).toThrow("first line is empty");
  });

  test("a key named like the claims directory works", () => {
    const ctx = fakeContext({ [get]: session("s-1"), [send]: ok() });
    expect(kickoff(ctx, spawned(), { ...options, key: "claims" })).toBe("sent");
    expect(readFileSync(receiptPath(ctx, "claims"), "utf8")).toBe(
      `claims:${A}:s-1\n`,
    );
  });

  test("a receipt that fails to be written after the send stays pending, and a later launch does not resend", () => {
    const ctx = withReceipt(
      {
        [get]: session("s-1"),
        // A directory takes the final receipt's temporary name once the
        // prompt is sent, which fails the write even for root.
        [send]: () => {
          mkdirSync(join(`${receiptPath(ctx, KEY)}.${process.pid}.tmp`, "x"), {
            recursive: true,
          });
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
        // While this launch checks, another takes the claim over by age.
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
