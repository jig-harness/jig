import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  normalizeAgentName,
  sessionReceiptPath,
  startAgent,
} from "../agent.ts";
import {
  agentExists,
  createAgentPane,
  herdrCall,
  probeAgentSession,
  reportAgentStatus,
  waitForAgentSettle,
} from "../herdr.ts";
import { fail, fakeContext, herdrError, ok, result } from "./fake.ts";

const A = "feat-x-12345678";
const get = `herdr agent get ${A}`;
const wait = `herdr agent wait ${A} --until idle --until blocked --until done --timeout 1000`;
const agent = (fields: Record<string, unknown>) => result({ agent: fields });

describe("herdrCall", () => {
  test("an error envelope on stderr is returned to the caller to decide on", () => {
    const ctx = fakeContext({ [get]: herdrError("agent_not_found") });
    expect(
      herdrCall(ctx, ["herdr", "agent", "get", A], "get").error?.code,
    ).toBe("agent_not_found");
  });
  test("a failure with no envelope is thrown", () => {
    const ctx = fakeContext({ [get]: fail(1, "connection refused") });
    expect(() => herdrCall(ctx, ["herdr", "agent", "get", A], "get")).toThrow(
      "connection refused",
    );
  });
});

describe("agentExists", () => {
  test("only not-found means no", () => {
    expect(
      agentExists(fakeContext({ [get]: herdrError("agent_not_found") }), A),
    ).toBe(false);
    expect(
      agentExists(fakeContext({ [get]: herdrError("not_found") }), A),
    ).toBe(false);
    expect(() =>
      agentExists(
        fakeContext({ [get]: herdrError("unauthorized", "denied") }),
        A,
      ),
    ).toThrow("denied");
  });
  test("a success without an agent is an error, not a no", () => {
    expect(() =>
      agentExists(fakeContext({ [get]: result({ agent: [] }) }), A),
    ).toThrow("no agent in the result");
    expect(agentExists(fakeContext({ [get]: agent({ name: A }) }), A)).toBe(
      true,
    );
  });
});

describe("probeAgentSession", () => {
  const probe = (answer: ReturnType<typeof ok>) =>
    probeAgentSession(fakeContext({ [get]: answer }), A);
  test("no session field is an answer: none", () => {
    expect(probe(agent({}))).toEqual({ ok: true, sessionId: null });
    expect(probe(agent({ agent_session: null }))).toEqual({
      ok: true,
      sessionId: null,
    });
    expect(probe(agent({ agent_session: { value: null } }))).toEqual({
      ok: true,
      sessionId: null,
    });
  });
  test("a session id is read", () => {
    expect(probe(agent({ agent_session: { value: "s-1" } }))).toEqual({
      ok: true,
      sessionId: "s-1",
    });
  });
  test("a present but malformed field, an error or no agent is not an answer", () => {
    for (const answer of [
      agent({ agent_session: { value: "" } }),
      agent({ agent_session: { value: "a b" } }),
      agent({ agent_session: { value: 7 } }),
      agent({ agent_session: "s-1" }),
      result({ agent: null }),
      herdrError("agent_not_found"),
      fail(1, "socket closed"),
    ])
      expect(probe(answer).ok).toBe(false);
  });
});

describe("waitForAgentSettle", () => {
  test("the settled state is returned", () => {
    const ctx = fakeContext({ [wait]: agent({ agent_status: "idle" }) });
    expect(waitForAgentSettle(ctx, A, 1000)).toBe("idle");
    expect(ctx.options[0]?.timeoutMs).toBeGreaterThan(1000);
  });
  test("a failed wait is checked before giving up, even on the last attempt", () => {
    const ctx = fakeContext({
      [wait]: herdrError("timeout"),
      [get]: [
        agent({ agent_status: "working" }),
        agent({ agent_status: "blocked" }),
      ],
    });
    expect(waitForAgentSettle(ctx, A, 1000)).toBe("blocked");
  });
  test("an agent still working after the retries is notified and thrown", () => {
    const notify = `herdr notification show ${A} unresponsive --body the workspace tool could not tell whether this agent settled; attach and check it. The agent and its pane are as they were.`;
    const ctx = fakeContext({
      [wait]: herdrError("timeout"),
      [get]: agent({ agent_status: "working" }),
      [notify]: ok(),
    });
    expect(() => waitForAgentSettle(ctx, A, 1000)).toThrow(
      "could not tell whether agent",
    );
    expect(ctx.calls.filter((c) => c === wait)).toHaveLength(4);
    expect(ctx.calls).toContain(notify);
  });
});

describe("reportAgentStatus", () => {
  const notify = `herdr notification show ${A} blocked --body answer the agent's startup dialog`;
  test("a blocked agent whose notification fails is thrown", () => {
    const ctx = fakeContext({ [notify]: fail(1, "no client") });
    expect(() => reportAgentStatus(ctx, A, "blocked")).toThrow(
      "notification failed",
    );
  });
  test("an idle agent is logged", () => {
    const ctx = fakeContext({});
    reportAgentStatus(ctx, A, "idle");
    expect(ctx.lines).toEqual([`✓ agent ${A} idle`]);
  });
});

test("an agent gets a tab of its own", () => {
  const create =
    "herdr tab create --workspace w1 --cwd /wt --label agent --no-focus";
  expect(
    createAgentPane(
      fakeContext({ [create]: result({ root_pane: { pane_id: "w1:p2" } }) }),
      "w1",
      "/wt",
    ),
  ).toBe("w1:p2");
  expect(() =>
    createAgentPane(fakeContext({ [create]: result({}) }), "w1", "/wt"),
  ).toThrow("no pane");
});

describe("normalizeAgentName", () => {
  test("names follow Herdr's rule and carry a hash", () => {
    for (const seed of [
      "feature/ABC-123-long-title-of-the-issue-here",
      "123",
      "Ü",
      "--",
      "a",
    ]) {
      const name = normalizeAgentName(seed, "/clone/.git");
      expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(name).toMatch(/-[0-9a-f]{8}$/);
    }
  });
  test("seeds that fold alike, and one branch in two clones, get different names", () => {
    expect(normalizeAgentName("Review One")).not.toBe(
      normalizeAgentName("review-one"),
    );
    expect(normalizeAgentName("feat/x", "/a/.git")).not.toBe(
      normalizeAgentName("feat/x", "/b/.git"),
    );
    expect(normalizeAgentName("feat/x", "/a/.git")).toBe(
      normalizeAgentName("feat/x", "/a/.git"),
    );
  });
});

describe("startAgent", () => {
  const start = `herdr agent start ${A} --kind claude --pane w1:p1`;
  const settled = { [wait]: agent({ agent_status: "idle" }) };

  test("a fresh start keeps the session it reads back", () => {
    const ctx = fakeContext({
      [start]: result({}),
      ...settled,
      [get]: agent({ agent_session: { value: "s-2" } }),
    });
    expect(startAgent(ctx, A, "w1:p1", "claude", 1000)).toEqual({
      status: "idle",
      sessionId: "s-2",
    });
    expect(readFileSync(sessionReceiptPath(ctx, A), "utf8")).toBe("s-2\n");
  });

  test("a resume Herdr refuses falls back to a plain start", () => {
    const ctx = fakeContext({
      [`${start} -- --resume s-old`]: herdrError(
        "agent_start_failed",
        "No conversation found",
      ),
      [start]: result({}),
      ...settled,
      [get]: agent({}),
    });
    const receipt = sessionReceiptPath(ctx, A);
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, "s-old\n");
    expect(startAgent(ctx, A, "w1:p1", "claude", 1000).status).toBe("idle");
    expect(ctx.calls).toContain(start);
    expect(ctx.lines.join("\n")).toContain("could not resume session s-old");
  });

  test("an agent stopped at a dialog is reported blocked, not failed", () => {
    const ctx = fakeContext({
      [start]: herdrError("agent_not_ready"),
      [wait]: agent({ agent_status: "blocked" }),
      [get]: agent({}),
      [`herdr notification show ${A} blocked --body answer the agent's startup dialog`]:
        ok(),
    });
    expect(startAgent(ctx, A, "w1:p1", "claude", 1000).status).toBe("blocked");
  });

  test("a busy pane is refused with the manual command", () => {
    const ctx = fakeContext({ [start]: herdrError("agent_pane_busy") });
    expect(() => startAgent(ctx, A, "w1:p1", "claude", 1000)).toThrow(
      "pane w1:p1 is busy",
    );
  });

  test("a kind that cannot resume never gets --resume", () => {
    const codexStart = `herdr agent start ${A} --kind codex --pane w1:p1`;
    const ctx = fakeContext({
      [codexStart]: result({}),
      ...settled,
      [get]: agent({}),
    });
    const receipt = sessionReceiptPath(ctx, A);
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, "s-old\n");
    startAgent(ctx, A, "w1:p1", "codex", 1000);
    expect(ctx.calls.some((c) => c.includes("--resume"))).toBe(false);
  });
});
