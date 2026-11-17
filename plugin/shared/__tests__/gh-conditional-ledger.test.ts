import { afterEach, expect, test } from "bun:test";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import {
  githubCredential,
  setForgeGovernor,
} from "../outbound/github-budget.ts";
import type { GhRun } from "../outbound/github.ts";
import { restOperation } from "../outbound/gh-ledger.ts";
import { currentMs } from "../time.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { traceGhRunner } from "../trace.ts";

afterEach(() => setForgeGovernor(null));

const conditional = ["api", "repos/o/r/pulls/1", "-H", 'If-None-Match: "one"'];

function client(
  status: number,
  output: "pipe" | "inherit" = "pipe",
  extra: Partial<GhRun> = {},
) {
  setForgeGovernor(budgetGovernor(memoryBudgetStore(), { share: () => null }));
  const runner = traceGhRunner<
    GhRun & { stdout: string | undefined },
    {
      stdout: "pipe" | "inherit";
      env: Record<string, string>;
      timeoutSec?: number;
    }
  >(
    async () => ({
      code: status === 304 ? 1 : 0,
      stdout:
        output === "pipe"
          ? `HTTP/2.0 ${status}\r\nEtag: "one"\r\n\r\n${status === 200 ? "{}" : ""}`
          : undefined,
      stderr: status === 304 ? "gh: HTTP 304" : "",
      timedOut: false,
      ...extra,
    }),
    () => 10,
    { stdout: output, env: { GH_TOKEN: "conditional-test" } },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: failure.reason,
      timedOut: false,
      held: failure,
    }),
  );
  return runner;
}

test.each([false, true])(
  "304 costs zero with caller headers %s",
  async (include) => {
    const events: CallRecord[] = [];
    const run = client(304);
    const answer = await withLedgerWriter(
      (e) => events.push(e),
      () => run([...conditional, ...(include ? ["--include"] : [])]),
    );
    expect(answer.stdout?.startsWith("HTTP/")).toBe(include);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requests: 1,
      notModified: 1,
      cost: 0,
      estimated: false,
      failure: null,
    });
  },
);

test.each([
  ['--header=If-None-Match: "one"'],
  ['-HIf-None-Match: "one"'],
  ["--header=If-Modified-Since: yesterday"],
])("304 costs zero with a joined conditional header: %s", async (header) => {
  const events: CallRecord[] = [];
  await withLedgerWriter(
    (e) => events.push(e),
    () => client(304)(["api", "repos/o/r/pulls/1", header]),
  );
  expect(events[0]).toMatchObject({
    requests: 1,
    cost: 0,
    estimated: false,
    failure: null,
  });
});

test("a conditional 200 costs one primary request", async () => {
  const events: CallRecord[] = [];
  await withLedgerWriter(
    (e) => events.push(e),
    () => client(200)(conditional),
  );
  expect(events[0]).toMatchObject({
    requests: 1,
    notModified: 0,
    cost: 1,
    estimated: false,
    failure: null,
  });
});

test("uncaptured answers do not claim measured quota cost", async () => {
  const events: CallRecord[] = [];
  await withLedgerWriter(
    (e) => events.push(e),
    () => client(304, "inherit")(conditional),
  );
  expect(events[0]).toMatchObject({ requests: 1, cost: null });
});

test("a local admission refusal records no sent request", async () => {
  const run = client(304);
  const governor = budgetGovernor(memoryBudgetStore(), { share: () => null });
  governor.observe(githubCredential({ GH_TOKEN: "conditional-test" }), {
    limitedUntil: currentMs() + 60_000,
  });
  setForgeGovernor(governor);
  const events: CallRecord[] = [];
  const answer = await withLedgerWriter(
    (e) => events.push(e),
    () => run(conditional),
  );
  expect(answer.held?.code).toBe("rate-limited");
  expect(events[0]).toMatchObject({
    requests: 0,
    cost: null,
    failure: "rate-limited",
  });
});

test.each([
  { extra: { timedOut: true }, failure: "too-costly" },
  { extra: { bufferExceeded: true }, failure: "invalid" },
])("an incomplete 304 remains a failure: %s", async ({ extra, failure }) => {
  const events: CallRecord[] = [];
  await withLedgerWriter(
    (e) => events.push(e),
    () => client(304, "pipe", extra)(conditional),
  );
  expect(events[0]).toMatchObject({ cost: 1, estimated: true, failure });
});

/** A runner whose `gh` prints `stdout`, recording each attempt. */
function printing(stdout: string) {
  setForgeGovernor(budgetGovernor(memoryBudgetStore(), { share: () => null }));
  return traceGhRunner<
    GhRun & { stdout: string },
    { env: Record<string, string>; timeoutSec?: number }
  >(
    async () => ({ code: 0, stdout, stderr: "", timedOut: false }),
    () => 10,
    { env: { GH_TOKEN: "window-test" } },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: failure.reason,
      timedOut: false,
      held: failure,
    }),
  );
}

const resourceHeaders = (resource: string) =>
  `HTTP/2.0 200 OK\r\nx-ratelimit-resource: ${resource}\r\nx-ratelimit-limit: 30\r\nx-ratelimit-remaining: 29\r\nx-ratelimit-reset: 9999999999\r\n\r\n{}`;

test.each([
  { args: ["pr", "view", "1"], stdout: "{}", window: "complexity" },
  { args: ["issue", "list"], stdout: "[]", window: "complexity" },
  { args: ["run", "list"], stdout: "[]", window: "requests" },
  { args: ["label", "create", "x"], stdout: "", window: "requests" },
  { args: ["pr", "diff", "1"], stdout: "", window: "unknown" },
  {
    args: ["api", "graphql", "-f", "query={ viewer { login } }"],
    stdout: "{}",
    window: "complexity",
  },
  { args: ["api", "rate_limit"], stdout: "{}", window: "none" },
  { args: ["api", "search/issues?q=x"], stdout: "{}", window: "search" },
  {
    args: ["api", "repos/o/r"],
    stdout: resourceHeaders("core"),
    window: "requests",
  },
  {
    args: ["api", "search/code?q=x"],
    stdout: resourceHeaders("code_search"),
    window: "code_search",
  },
])(
  "a run of $args is recorded against the $window window",
  async ({ args, stdout, window }) => {
    const events: CallRecord[] = [];
    await withLedgerWriter(
      (e) => events.push(e),
      () => printing(stdout)([...args]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      window,
      owner: githubCredential({ GH_TOKEN: "window-test" }),
    });
  },
);

test("a later page's route, named by the repository's id, keeps its shape", () => {
  expect(
    restOperation("GET", "repositories/212613049/commits/abc/check-runs"),
  ).toBe("GET /repositories/{}/commits/{}/check-runs");
});
