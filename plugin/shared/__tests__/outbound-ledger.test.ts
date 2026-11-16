import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../records/db.ts";
import { BUDGET_MIGRATIONS } from "../outbound/schema.ts";
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
  closeDatabase(p);
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

test("a row keeps the quota owner and the window it spent, and an earlier row reads with neither", () => {
  const p = path();
  const at = 300 * hour;
  recordCall({
    path: p,
    system: "github",
    credential: "github:token",
    owner: "github:owner",
    window: "complexity",
    operation: "pr view",
    cost: 1,
    estimated: true,
    durationMs: 1,
    at,
  });
  // A copy that knows only the row's twelve columns still writes them.
  const opened = openDatabase({ path: p, migrations: BUDGET_MIGRATIONS });
  if (!opened.ok) throw new Error(opened.failure.reason);
  opened.value
    .query(
      "INSERT OR REPLACE INTO outbound_cost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      at,
      "github",
      "github:other",
      "pr list",
      "skill:x",
      "requests",
      1,
      1,
      0,
      1,
      1,
      "{}",
    );
  opened.value
    .query(
      "INSERT INTO github_owner (credential, host, owner, verified, login, checked_at, retry_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      "github:other",
      "github.com",
      "github:owner",
      1,
      "octo",
      at,
      at + hour,
    );
  const rows = ledgerReport({ path: p, since: at - hour, until: at + 1 }).rows;
  expect(rows.find((r) => r.operation === "pr view")).toMatchObject({
    owner: "github:owner",
    window: "complexity",
  });
  // An earlier row names no window; its owner is the one the machine knows.
  expect(rows.find((r) => r.operation === "pr list")).toMatchObject({
    owner: "github:owner",
    window: null,
  });
});

test("a database an earlier copy created reads without the quota tables", () => {
  const p = path();
  const at = 300 * hour;
  const opened = openDatabase({
    path: p,
    migrations: BUDGET_MIGRATIONS.slice(0, 2),
  });
  if (!opened.ok) throw new Error(opened.failure.reason);
  opened.value
    .query("INSERT INTO outbound_cost VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      at,
      "github",
      "github:old",
      "pr view",
      "skill:x",
      "requests",
      1,
      1,
      0,
      1,
      1,
      "{}",
    );
  closeDatabase(p);
  const rows = ledgerReport({ path: p, since: at - hour, until: at + 1 }).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ owner: null, window: null, requests: 1 });
});
