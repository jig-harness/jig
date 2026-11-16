import { describe, expect, it } from "bun:test";
import {
  budgetGovernor,
  memoryBudgetStore,
} from "../../shared/outbound/budget.ts";
import {
  forgeAnswerOf,
  githubBalances,
  githubCredential,
} from "../../shared/outbound/github-budget.ts";
import { recordedBudget } from "../lib/tick-reads.ts";

const window = (
  remaining: number | null,
  resetAt: number,
  answeredAt: number | null = 10_000_000 - 30_000,
) => ({
  limit: 5000,
  remaining,
  resetAt,
  answeredAt,
});

describe("the tick's forge budget from the machine's record", () => {
  const now = 10_000_000;

  it("reads the core balance an answer recorded within the last minute", () => {
    expect(
      recordedBudget(now, {
        core: window(2600.4, now + 600_000),
        graphql: window(4000, now + 600_000),
        observedAt: now - 30_000,
      }),
    ).toEqual({
      remaining: 2600,
      limit: 5000,
      resetAt: new Date(now + 600_000).toISOString(),
    });
  });

  it("reads a window whose reset has passed as full", () => {
    expect(
      recordedBudget(now, {
        core: window(0, now - 1),
        graphql: window(4000, now + 600_000),
        observedAt: now - 30_000,
      })?.remaining,
    ).toBe(5000);
  });

  it("asks the forge when the record is older than a minute, holds no core balance, or is missing", () => {
    const fresh = {
      graphql: window(4000, now + 600_000),
      observedAt: now - 30_000,
    };
    expect(
      recordedBudget(now, {
        ...fresh,
        core: window(2600, now + 600_000, now - 61_000),
        observedAt: now - 61_000,
      }),
    ).toBeNull();
    // Another window's answer keeps the record fresh, not the core balance.
    expect(
      recordedBudget(now, {
        ...fresh,
        core: window(2600, now + 600_000, now - 61_000),
        observedAt: now - 1_000,
      }),
    ).toBeNull();
    expect(
      recordedBudget(now, { ...fresh, core: window(null, now + 600_000) }),
    ).toBeNull();
    expect(recordedBudget(now, null)).toBeNull();
  });

  it("asks the forge for the core balance after a run of GraphQL-only answers, which keep only their own window current", () => {
    const env = { GH_TOKEN: "tick-budget-token" };
    const key = githubCredential(env);
    const store = memoryBudgetStore();
    let at = now - 300_000;
    const governor = budgetGovernor(store, {
      clock: () => at,
      share: () => null,
    });
    const reset = Math.floor((now + 1_800_000) / 1000);
    const rateLimit = (core: number, graphql: number) =>
      JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: core, reset },
          graphql: { limit: 5000, remaining: graphql, reset },
        },
      });
    governor.observe(
      key,
      forgeAnswerOf(
        ["api", "rate_limit"],
        null,
        rateLimit(4000, 4500),
        null,
        at,
      ),
      at,
    );
    // GraphQL answers every twenty seconds since, each reporting its own window.
    for (let remaining = 4490; at < now; remaining -= 10) {
      at += 20_000;
      const headers = new Headers({
        "x-ratelimit-resource": "graphql",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(reset),
      });
      governor.observe(
        key,
        forgeAnswerOf(["api", "graphql"], headers, '{"data":{}}', null, at),
        at,
        "complexity",
      );
    }
    const balances = () => githubBalances(env, (k) => store.read(k));
    expect(now - (balances()?.observedAt ?? 0)).toBeLessThan(60_000);
    expect(now - (balances()?.graphql.answeredAt ?? 0)).toBeLessThan(60_000);
    expect(recordedBudget(now, balances())).toBeNull();

    // The tick's one `rate_limit` read reports the core window again.
    governor.observe(
      key,
      forgeAnswerOf(
        ["api", "rate_limit"],
        null,
        rateLimit(3990, 4350),
        null,
        at,
      ),
      at,
    );
    expect(recordedBudget(now, balances())?.remaining).toBe(3990);
  });
});
