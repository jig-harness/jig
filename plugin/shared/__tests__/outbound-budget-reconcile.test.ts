import { describe, expect, it } from "bun:test";
import {
  type BudgetRecord,
  budgetGovernor,
  memoryBudgetStore,
} from "../outbound/budget.ts";

const KEY = "reconcile-credential";
const reset = 2_000_000;

function record(): BudgetRecord {
  return {
    requests: { limit: null, remaining: null, resetAt: null },
    complexity: { limit: null, remaining: null, resetAt: null },
    limitedUntil: null,
    why: null,
    observedAt: 1,
  };
}

describe("an ordinary answer's reconciliation with the stored balance", () => {
  it("compares an ordinary answer with the stored balance after taking the later reservations from it", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 2504, resetAt: reset, readAt: now },
    }));
    now += 5;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    now += 5;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    now += 1;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(store.read(KEY)?.requests.remaining).toBe(2501);
    now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 2502, resetAt: reset } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(2500);
  });

  it("tells reservations made in the request's own millisecond from the request, so releasing one still gives it back", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 4000, resetAt: reset, readAt: now },
    }));
    now += 5;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    const unsentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(unsentAt).toBe(sentAt);
    now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 3990, resetAt: reset } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(3989);
    governor.release?.(KEY, "requests", unsentAt);
    expect(store.read(KEY)?.requests.remaining).toBe(3990);
  });

  it("takes the reservations the cap forgot from an ordinary answer's balance", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 5000, resetAt: reset, readAt: now },
    }));
    now += 1;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    for (let i = 0; i < 300; i += 1) {
      now += 1;
      governor.admit("GitHub", KEY, { reserve: "requests" });
    }
    now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 4000, resetAt: reset } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBeLessThanOrEqual(3700);
  });

  it("keeps a reservation made in the millisecond an unreserved request was sent", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 4000, resetAt: reset, readAt: now },
    }));
    now += 5;
    // A conditional request reserves nothing; another reserves in its millisecond.
    const sentAt = governor.admit("GitHub", KEY, { reserve: null });
    governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
    now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 3990, resetAt: reset } },
      sentAt,
      null,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(3989);
  });
});
