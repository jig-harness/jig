/**
 * Spending the `rate_limit` endpoint's balance shows that no counted request
 * explains goes to the cost ledger's unattributed row, never to an operation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import {
  forgeAnswerOf,
  githubCredential,
  setForgeGovernor,
} from "../outbound/github-budget.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import {
  type CallRecord,
  UNATTRIBUTED,
  withLedgerWriter,
} from "../outbound/ledger.ts";
import { currentMs } from "../time.ts";
import { traceGhRunner } from "../trace.ts";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  held?: OutboundFailure;
}

const ENV = { GH_TOKEN: "unattributed-token" };
const KEY = githubCredential(ENV);

afterEach(() => setForgeGovernor(null));

/** A forge client whose `gh` is `answer`. */
function client(answer: (argv: string[]) => string) {
  const runner = traceGhRunner<
    Run,
    { env?: Record<string, string>; timeoutSec?: number }
  >(
    async (argv) => ({
      code: 0,
      stdout: answer(argv),
      stderr: "",
      timedOut: false,
    }),
    () => 10,
    { env: ENV },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: `${failure.reason}\n`,
      timedOut: false,
      held: failure,
    }),
  );
  return (args: string[]) => runner(args, { env: ENV });
}

function headers(lines: Record<string, string | number>): string {
  return `HTTP/2.0 200 OK\n${Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n\n`;
}

describe("the unattributed row of the cost ledger", () => {
  it("records what a rate_limit balance shows spent beyond the counted requests, per window in its own unit", async () => {
    setForgeGovernor(
      budgetGovernor(memoryBudgetStore(), { share: () => null }),
    );
    const reset = Math.floor(currentMs() / 1000) + 1800;
    const window = (resource: string, remaining: number) =>
      headers({
        "X-Ratelimit-Resource": resource,
        "X-Ratelimit-Limit": 5000,
        "X-Ratelimit-Remaining": remaining,
        "X-Ratelimit-Reset": reset,
      });
    const rateLimit = JSON.stringify({
      resources: {
        core: { limit: 5000, remaining: 3990, reset },
        graphql: { limit: 5000, remaining: 4480, reset },
      },
    });
    const gh = client((argv) => {
      if (argv.includes("repos/o/r")) return `${window("core", 4000)}{}`;
      if (argv.includes("graphql")) return `${window("graphql", 4500)}{}`;
      if (argv.includes("rate_limit"))
        return argv.includes("--include")
          ? `${headers({})}${rateLimit}`
          : rateLimit;
      return "{}";
    });
    const rows: CallRecord[] = [];
    await withLedgerWriter(
      (row) => rows.push(row),
      async () => {
        await gh(["api", "repos/o/r"]);
        await gh(["api", "graphql", "-f", "query={ viewer { login } }"]);
        // Shows no headers: reserves the one point a query costs at least.
        await gh(["pr", "view", "1", "--json", "title"]);
        await gh(["api", "rate_limit"]);
      },
    );
    const unattributed = rows.filter((r) => r.operation === UNATTRIBUTED);
    expect(unattributed).toEqual([
      expect.objectContaining({
        system: "github",
        credential: KEY,
        owner: KEY,
        window: "requests",
        caller: UNATTRIBUTED,
        unit: "requests",
        requests: 0,
        cost: 10,
        estimated: false,
      }),
      expect.objectContaining({
        owner: KEY,
        window: "complexity",
        caller: UNATTRIBUTED,
        unit: "points",
        requests: 0,
        cost: 19,
      }),
    ]);
    // No operation is charged with it.
    expect(
      rows
        .filter((r) => r.operation !== UNATTRIBUTED)
        .every((r) => r.caller !== UNATTRIBUTED),
    ).toBe(true);
  });

  it("does not record again the cost a cost-only answer measured beyond its reservation", async () => {
    setForgeGovernor(
      budgetGovernor(memoryBudgetStore(), { share: () => null }),
    );
    const reset = Math.floor(currentMs() / 1000) + 1800;
    let remaining = 4500;
    const gh = client((argv) => {
      if (argv.includes("rate_limit"))
        return JSON.stringify({
          resources: { graphql: { limit: 5000, remaining, reset } },
        });
      return JSON.stringify({ data: { rateLimit: { cost: 9 } } });
    });
    const rows: CallRecord[] = [];
    await withLedgerWriter(
      (row) => rows.push(row),
      async () => {
        await gh(["api", "rate_limit"]);
        await gh(["api", "graphql", "-f", "query={ viewer { login } }"]);
        // The nine points the query cost left the balance.
        remaining = 4491;
        await gh(["api", "rate_limit"]);
      },
    );
    expect(rows.filter((r) => r.operation === UNATTRIBUTED)).toEqual([]);
  });

  it("keeps a cost-only answer's extra points against a snapshot sent before it, and skips them once a newer snapshot holds them", () => {
    let now = 1_000_000;
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    const reset = 1_800_000;
    const window = (remaining: number) => ({
      limit: 5000,
      remaining,
      resetAt: reset,
    });
    const snapshot = (remaining: number) => ({
      snapshot: true,
      complexity: window(remaining),
    });
    const complexity = () => store.read(KEY)?.complexity.remaining;
    governor.observe(KEY, snapshot(2509), now);
    const snapshotSentAt = now;
    now += 10;
    const sentAt = governor.admit("GitHub", KEY, {
      windows: ["complexity"],
      reserve: "complexity",
    });
    now += 10;
    // The query cost nine points: one reserved, eight beyond it.
    governor.observe(KEY, { extraComplexity: 8 }, sentAt, "complexity");
    expect(complexity()).toBe(2500);
    // The earlier snapshot answers late, with the balance before the query.
    now += 10;
    governor.observe(KEY, snapshot(2509), snapshotSentAt);
    expect(complexity()).toBe(2500);
    // A snapshot sent after the query already holds its cost: nothing twice.
    now += 10;
    const laterSent = now;
    governor.observe(KEY, snapshot(91), laterSent);
    now += 10;
    governor.observe(KEY, { extraComplexity: 8 }, sentAt, "complexity");
    expect(complexity()).toBe(91);
  });

  it("records nothing when the counted requests explain the balance, or the balance is another window's", () => {
    let now = 1_000_000;
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    const reset = 1_800;
    const snapshot = (core: number, at: number, resetAt = reset) =>
      forgeAnswerOf(
        ["api", "rate_limit"],
        null,
        JSON.stringify({
          resources: { core: { limit: 5000, remaining: core, reset: resetAt } },
        }),
        null,
        at,
      );
    expect(governor.observe(KEY, snapshot(4000, now), now)).toEqual({});
    // Two requests counted, two spent.
    governor.admit("GitHub", KEY, {
      windows: ["requests"],
      reserve: "requests",
    });
    governor.admit("GitHub", KEY, {
      windows: ["requests"],
      reserve: "requests",
    });
    now += 1_000;
    expect(governor.observe(KEY, snapshot(3998, now), now)).toEqual({});
    // Three more spent than counted.
    now += 1_000;
    expect(governor.observe(KEY, snapshot(3995, now), now)).toEqual({
      requests: 3,
    });
    // The window reset: the new balance says nothing of the old one.
    now += 1_000;
    expect(
      governor.observe(KEY, snapshot(4990, now, reset + 3600), now),
    ).toEqual({});
  });
});
