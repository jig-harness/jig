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
  agentSessionId: "s-1",
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
    expect(reconcileKickoff(ctx, A, KEY, PROMPT)).toBe("delivered");
    expect(ctx.calls).not.toContain(read);
  });
  test("a receipt for another session of this agent: undelivered, without the transcript", () => {
    for (const line of [`${KEY}:${A}:s-0`, `${KEY}:${A}`]) {
      const ctx = withReceipt({ [get]: session("s-1") }, line);
      expect(reconcileKickoff(ctx, A, KEY, PROMPT)).toBe("undelivered");
      expect(ctx.calls).not.toContain(read);
    }
  });
  test("no receipt: the transcript decides", () => {
    const seen = withReceipt(
      { [get]: session(null), [read]: ok("❯ /jig:do-item ABC-1\n") },
      null,
    );
    expect(reconcileKickoff(seen, A, KEY, PROMPT)).toBe("delivered");
    const unseen = withReceipt(
      { [get]: session(null), [read]: ok("❯ hello\n") },
      null,
    );
    expect(reconcileKickoff(unseen, A, KEY, PROMPT)).toBe("undelivered");
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
    expect(acquireClaim(ctx, KEY, 0, 60_000)).toBe("1");
  });
});

describe("kickoff", () => {
  const claims = (ctx: { stateDir: string }) =>
    existsSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      ? readdirSync(join(ctx.stateDir, "kickoff", "claims", KEY))
      : [];

  test("a new agent is sent the prompt and the receipt written", () => {
    const ctx = fakeContext({ [send]: ok() });
    expect(kickoff(ctx, spawned(), options)).toBe("sent");
    expect(readFileSync(receiptPath(ctx, KEY), "utf8")).toBe(
      `${KEY}:${A}:s-1\n`,
    );
    expect(claims(ctx)).toEqual([]);
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

  test("a prompt Herdr refuses releases the claim", () => {
    for (const answer of [
      herdrError("agent_blocked", "agent is blocked"),
      fail(2, "usage"),
    ]) {
      const ctx = fakeContext({ [send]: answer });
      expect(() => kickoff(ctx, spawned(), options)).toThrow(
        "did not take the kickoff",
      );
      expect(claims(ctx)).toEqual([]);
    }
  });

  test("a prompt that may or may not have landed keeps the claim and writes no receipt", () => {
    const ctx = fakeContext({ [send]: fail(-1, "spawn error: timed out") });
    expect(() => kickoff(ctx, spawned(), options)).toThrow(
      "could not tell whether",
    );
    expect(claims(ctx)).toEqual(["1"]);
    expect(existsSync(receiptPath(ctx, KEY))).toBe(false);
  });
});
