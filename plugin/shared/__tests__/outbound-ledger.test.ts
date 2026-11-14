import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../records/db.ts";
import {
  ledgerReport,
  recordCall,
  callerForChild,
  withCaller,
  withLedgerPath,
  operationName,
} from "../outbound/ledger.ts";
import { sqliteBudgetStore, budgetGovernor } from "../outbound/budget.ts";
const roots: string[] = [];
const paths: string[] = [];
function path(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-ledger-"));
  roots.push(root);
  const p = join(root, "budget.sqlite");
  paths.push(p);
  return p;
}
afterEach(() => {
  for (const p of paths.splice(0)) closeDatabase(p);
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const hour = 3_600_000;
test("hourly totals preserve operation, credential, caller, costs and failures alongside existing budget", async () => {
  const p = path();
  const at = 200 * hour + 100;
  const governor = budgetGovernor(sqliteBudgetStore(p), { clock: () => at });
  governor.observe("linear:key", {
    complexity: {
      limit: 3000000,
      remaining: 2999900,
      resetAt: at + hour,
      refillMs: hour,
    },
  });
  await withLedgerPath(p, () =>
    withCaller("tick:one", async () => {
      recordCall({
        system: "linear",
        credential: "linear:key",
        operation: "ReadItems",
        unit: "points",
        cost: 40,
        durationMs: 5,
        at,
      });
      await Promise.resolve();
      recordCall({
        system: "linear",
        credential: "linear:key",
        operation: "ReadItems",
        unit: "points",
        cost: 60,
        durationMs: 7,
        failure: "server-fault",
        at: at + 1,
      });
    }),
  );
  const report = ledgerReport({ path: p, since: at - hour, until: at + 2 });
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0]).toMatchObject({
    caller: "tick:one",
    requests: 2,
    cost: 100,
    durationMs: 12,
    failures: { "server-fault": 1 },
  });
  expect(report.balances[0]?.record.complexity.remaining).toBe(2999900);
});
test("retention prunes old totals and a broken ledger never interrupts a call", () => {
  const p = path();
  const at = 200 * hour;
  recordCall({
    system: "linear",
    credential: "key",
    operation: "Old",
    cost: 1,
    durationMs: 1,
    at: at - 8 * 24 * hour,
    path: p,
  });
  recordCall({
    system: "linear",
    credential: "key",
    operation: "Now",
    cost: null,
    durationMs: 1,
    at,
    path: p,
  });
  expect(
    ledgerReport({ path: p, since: 0, until: at + 1 }).rows.map(
      (r) => r.operation,
    ),
  ).toEqual(["Now"]);
  expect(() =>
    recordCall({
      system: "linear",
      credential: "key",
      operation: "Read",
      cost: 1,
      durationMs: 1,
      path: join(p, "cannot-open"),
    }),
  ).not.toThrow();
});
test("concurrent caller contexts stay separate and operation names omit query contents", async () => {
  const p = path();
  const at = Date.now();
  await withLedgerPath(p, () =>
    Promise.all(
      ["tick:a", "pass:drive:b"].map((caller) =>
        withCaller(caller, async () => {
          await Promise.resolve();
          recordCall({
            system: "github",
            credential: "key",
            operation: "Read",
            cost: null,
            durationMs: 1,
            at,
          });
        }),
      ),
    ),
  );
  expect(
    ledgerReport({ path: p, since: at - hour })
      .rows.map((r) => r.caller)
      .sort(),
  ).toEqual(["pass:drive:b", "tick:a"]);
  expect(
    operationName("query ReadItems($id: ID!) { issue(id:$id) { id } }"),
  ).toBe("ReadItems");
  expect(operationName("{ viewer { secret } }")).toMatch(
    /^query:viewer-[a-f0-9]+$/,
  );
});

test("a child inherits its enclosing caller", () => {
  expect(withCaller("tick:preflight", callerForChild)).toBe("tick:preflight");
});

test("a locked ledger discards accounting without delaying the outbound caller", () => {
  const p = path();
  recordCall({
    path: p,
    system: "github",
    credential: "key",
    operation: "First",
    cost: 1,
    durationMs: 1,
  });
  const lock = new Database(p);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const began = performance.now();
    recordCall({
      path: p,
      system: "github",
      credential: "key",
      operation: "Blocked",
      cost: 1,
      durationMs: 1,
    });
    expect(performance.now() - began).toBeLessThan(1_000);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});
