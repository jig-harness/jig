import { describe, expect, it } from "bun:test";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { emptyRecord, RESET, seededBudget } from "./outbound-budget-fixture.ts";

const KEY = "reconcile-credential";

describe("an ordinary answer's reconciliation with the stored balance", () => {
  it("compares an ordinary answer with the stored balance after taking the later reservations from it", () => {
    const { store, governor, clock } = seededBudget(KEY, 2504);
    clock.now += 5;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    clock.now += 5;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    clock.now += 1;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(store.read(KEY)?.requests.remaining).toBe(2501);
    clock.now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 2502, resetAt: RESET } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(2500);
  });

  it("tells reservations made in the request's own millisecond from the request, so releasing one still gives it back", () => {
    const { store, governor, clock } = seededBudget(KEY, 4000);
    clock.now += 5;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    const unsentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(unsentAt).toBe(sentAt);
    clock.now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 3990, resetAt: RESET } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(3989);
    governor.release?.(KEY, "requests", unsentAt);
    expect(store.read(KEY)?.requests.remaining).toBe(3990);
  });

  it("takes the reservations the cap forgot from an ordinary answer's balance", () => {
    const { store, governor, clock } = seededBudget(KEY, 5000);
    clock.now += 1;
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    for (let i = 0; i < 300; i += 1) {
      clock.now += 1;
      governor.admit("GitHub", KEY, { reserve: "requests" });
    }
    clock.now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 4000, resetAt: RESET } },
      sentAt,
    );
    expect(store.read(KEY)?.requests.remaining).toBeLessThanOrEqual(3700);
  });

  it("keeps a reservation made in the millisecond an unreserved request was sent", () => {
    const { store, governor, clock } = seededBudget(KEY, 4000);
    clock.now += 5;
    // A conditional request reserves nothing; another reserves in its millisecond.
    const sentAt = governor.admit("GitHub", KEY, { reserve: null });
    governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
    clock.now += 10;
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 3990, resetAt: RESET } },
      sentAt,
      null,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(3989);
  });

  it("reports a requested reservation that was never created as none", () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => 1_000_000,
      share: () => null,
    });
    store.update(KEY, emptyRecord);
    const seen: (string | null)[] = [];
    governor.admit("GitHub", KEY, {
      reserve: "requests",
      onReserved: (name) => seen.push(name),
    });
    expect(seen).toEqual([null]);
  });

  it("does not take the answered request for a retained reservation once equal-millisecond ones overflowed", () => {
    const { store, governor } = seededBudget(KEY, 5000);
    const sentAt = governor.admit("GitHub", KEY, { reserve: "requests" });
    for (let i = 0; i < 300; i++)
      governor.admit("GitHub", KEY, { reserve: "requests" });
    governor.observe(
      KEY,
      { requests: { limit: 5000, remaining: 4000, resetAt: RESET } },
      sentAt,
      "requests",
    );
    // 300 later reservations come off the answer's 4000; never more credit.
    expect(store.read(KEY)?.requests.remaining).toBeLessThanOrEqual(3700);
  });
});
