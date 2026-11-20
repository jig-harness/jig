import { describe, expect, test } from "bun:test";
import {
  budgetGovernor,
  type BudgetWindow,
  memoryBudgetStore,
} from "../../../shared/outbound/budget.ts";
import {
  graphqlPollFloors,
  lowerGraphqlBalance,
} from "../../../shared/outbound/graph-poll-budget.ts";
import {
  type CallRecord,
  withLedgerWriter,
} from "../../../shared/outbound/ledger.ts";
import { emptyReport } from "../scripts/lib/status/evaluate.ts";
import {
  pollDependencies,
  pollFingerprint,
  readStatusPolling,
  StatusPollPacing,
} from "../scripts/lib/status/poll-pacing.ts";

const second = 1000;
const base = 30 * second;
const defaultPolicy = readStatusPolling({});
const window = (remaining: number, resetIn: number): BudgetWindow => ({
  remaining,
  resetAt: resetIn * second,
  limit: 5000,
});

function fixture(
  balance: (now: number) => BudgetWindow | undefined,
  baseMs = base,
) {
  let now = 0;
  const clock = {
    now: () => now,
    async sleep(ms: number) {
      now += ms;
    },
  };
  const ledger: CallRecord[] = [];
  const pacing = new StatusPollPacing(baseMs, defaultPolicy, {
    ...pollDependencies(clock),
    balance: () => {
      const observed = balance(now);
      return observed === undefined
        ? { windows: [] }
        : { windows: [observed], credential: "test-account" };
    },
  });
  return {
    clock,
    ledger,
    wait: (
      report: string,
      deadline: number,
      abort?: AbortSignal,
      maximumMs?: number,
    ) =>
      withLedgerWriter(
        (entry) => ledger.push(entry),
        () => pacing.wait(report, deadline, abort, maximumMs),
      ),
  };
}

describe("waiting status poll pacing", () => {
  test("a reviewer ceiling never shortens the requested base interval", async () => {
    const probe = fixture(() => window(4500, 3600));
    expect(
      await probe.wait("reviewer", 100 * second, undefined, 3 * second),
    ).toBe(true);
    expect(probe.clock.now()).toBe(30 * second);
    expect(await probe.wait("other", 200 * second)).toBe(true);
    expect(probe.clock.now()).toBe(60 * second);
  });

  test("an unchanged reviewer wait doubles to its capped cadence", async () => {
    const probe = fixture(() => window(4500, 3600), second);
    const deadline = 10 * second;
    const wakes: number[] = [];

    while (await probe.wait("reviewer", deadline, undefined, 3 * second))
      wakes.push(probe.clock.now());

    expect(wakes).toEqual([1, 3, 6, 9].map((s) => s * second));
    expect(probe.clock.now()).toBe(deadline);
  });

  test("fewer polls over half an hour and an observed change resets the cadence", async () => {
    const probe = fixture(() => window(4500, 3600));
    const report = emptyReport();
    report.apiHead = "first";
    const fingerprint = pollFingerprint(report);
    const deadline = 1800 * second;
    const polled: number[] = [];
    while (await probe.wait(fingerprint, deadline))
      polled.push(probe.clock.now());
    expect(polled.slice(0, 4)).toEqual(
      [30, 90, 210, 450].map((s) => s * second),
    );
    expect(polled.length).toBeLessThan(deadline / base);
    expect(probe.clock.now()).toBe(deadline);

    report.apiHead = "second";
    expect(await probe.wait(pollFingerprint(report), deadline + base * 2)).toBe(
      true,
    );
    expect(probe.clock.now()).toBe(deadline + base);
    expect(
      probe.ledger.some(
        (entry) => entry.operation === "drive-status poll skipped",
      ),
    ).toBe(true);
    expect(
      probe.ledger.every(
        (entry) =>
          entry.requests === 0 &&
          entry.unit === "polls" &&
          entry.window === "none",
      ),
    ).toBe(true);
  });

  test("a low balance discovered after sleeping defers the next poll", async () => {
    const probe = fixture((now) =>
      now === 0 ? window(4500, 600) : window(500, 600),
    );
    expect(await probe.wait("same", 200 * second)).toBe(true);
    expect(probe.clock.now()).toBe(75 * second);
  });

  test("near exhaustion suppresses all polls until reset or wall-clock deadline", async () => {
    const ended = fixture(() => window(100, 200));
    expect(await ended.wait("same", 100 * second)).toBe(false);
    expect(ended.clock.now()).toBe(100 * second);
    expect(
      ended.ledger.map(({ operation, cost, durationMs }) => ({
        operation,
        cost,
        durationMs,
      })),
    ).toEqual([
      {
        operation: "drive-status poll wait",
        cost: 1,
        durationMs: 100 * second,
      },
      { operation: "drive-status poll skipped", cost: 3, durationMs: 0 },
    ]);

    const resumed = fixture((now) =>
      now < 200 * second ? window(100, 200) : window(4500, 600),
    );
    expect(await resumed.wait("same", 250 * second)).toBe(true);
    expect(resumed.clock.now()).toBe(200 * second);
  });

  test("an aborted wait records every suppressed base-cadence poll", async () => {
    let now = 0;
    const ledger: CallRecord[] = [];
    const controller = new AbortController();
    const pacing = new StatusPollPacing(base, defaultPolicy, {
      now: () => now,
      async sleep() {
        now += 95 * second;
        controller.abort();
      },
      balance: () => ({ windows: [window(4500, 600)] }),
      record(credential, durationMs, skipped) {
        const entry = {
          system: "github" as const,
          credential: credential ?? "(unavailable)",
          owner: credential ?? null,
          window: "none",
          unit: "polls",
          requests: 0,
        };
        ledger.push({
          ...entry,
          operation: "drive-status poll wait",
          cost: 1,
          durationMs,
        });
        if (skipped > 0)
          ledger.push({
            ...entry,
            operation: "drive-status poll skipped",
            cost: skipped,
            durationMs: 0,
          });
      },
    });

    expect(await pacing.wait("same", 300 * second, controller.signal)).toBe(
      false,
    );
    expect(ledger.at(-1)?.cost).toBe(3);
  });

  test("an alternate higher reading cannot override a live lower reading", async () => {
    const probe = fixture((now) =>
      now === 0 ? window(500, 400) : window(4500, 600),
    );
    expect(await probe.wait("same", 100 * second)).toBe(true);
    expect(probe.clock.now()).toBe(75 * second);
    expect(await probe.wait("changed", 250 * second)).toBe(true);
    expect(probe.clock.now()).toBe(150 * second);
  });

  test("an exhausted balance without a limit holds despite a healthy alternate", async () => {
    const probe = fixture((now) =>
      now === 0 ? { ...window(0, 200), limit: null } : window(4500, 600),
    );
    expect(await probe.wait("same", 250 * second)).toBe(true);
    expect(probe.clock.now()).toBe(200 * second);
  });

  test("the most restrictive percentage holds despite having more absolute points", async () => {
    let now = 0;
    const pacing = new StatusPollPacing(base, defaultPolicy, {
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
      balance: () => ({
        credential: "test-account",
        windows: [window(400, 500), { ...window(500, 200), limit: 15_000 }],
      }),
      record() {
        // This fixture only measures the selected wake time.
      },
    });
    expect(await pacing.wait("same", 300 * second)).toBe(true);
    expect(now).toBe(200 * second);
  });

  test("the governor retains same-reset capacities through a healthy snapshot", async () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => 0,
      keepGraphqlPollFloor: true,
    });
    const owner = "test-account";
    governor.observe(
      owner,
      { snapshot: true, complexity: window(400, 500) },
      0,
    );
    governor.observe(
      owner,
      {
        snapshot: true,
        complexity: { ...window(500, 500), limit: 15_000 },
      },
      0,
    );
    governor.observe(
      owner,
      { snapshot: true, complexity: window(4500, 600) },
      0,
    );

    let now = 0;
    const pacing = new StatusPollPacing(base, defaultPolicy, {
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
      balance: () => ({
        credential: owner,
        windows: graphqlPollFloors(store.read(owner)?.windows, now),
      }),
      record() {
        // This fixture only measures the selected wake time.
      },
    });
    expect(await pacing.wait("same", 550 * second)).toBe(true);
    expect(now).toBe(500 * second);
  });

  test("a partial lower balance can use the known capacity of the same account", async () => {
    const probe = fixture((now) =>
      now === 0 ? window(4500, 600) : { ...window(1, 200), limit: null },
    );
    expect(await probe.wait("same", 150 * second)).toBe(false);
    expect(probe.clock.now()).toBe(150 * second);
  });

  test("an equal balance with a later reset retains the known capacity", () => {
    expect(
      lowerGraphqlBalance(
        [window(100, 200), { ...window(100, 300), limit: null }],
        0,
      ),
    ).toEqual(window(100, 300));
  });

  test("an unreadable balance does not discard the owner's last live lower reading", async () => {
    const probe = fixture((now) => (now === 0 ? window(500, 400) : undefined));
    expect(await probe.wait("same", 100 * second)).toBe(true);
    expect(probe.clock.now()).toBe(75 * second);
    expect(await probe.wait("changed", 250 * second)).toBe(true);
    expect(probe.clock.now()).toBe(150 * second);
  });

  test("the budget store keeps an alternate lower window across probes", () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => 0,
      keepGraphqlPollFloor: true,
    });
    const owner = "test-account";
    governor.observe(
      owner,
      { snapshot: true, complexity: window(4500, 600) },
      0,
    );
    governor.observe(
      owner,
      { snapshot: true, complexity: window(100, 200) },
      0,
    );
    expect(store.read(owner)?.complexity.remaining).toBe(4500);
    expect(graphqlPollFloors(store.read(owner)?.windows, 0)).toEqual(
      expect.arrayContaining([window(4500, 600), window(100, 200)]),
    );
  });
});
