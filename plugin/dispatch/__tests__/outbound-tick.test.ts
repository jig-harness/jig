import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  budgetGovernor,
  budgetPath,
  sqliteBudgetStore,
} from "../../shared/outbound/budget.ts";
import {
  ledgerReport,
  recordCall,
  withCaller,
  withLedgerPath,
} from "../../shared/outbound/ledger.ts";
import { httpTransport } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { quotaRisks } from "../lib/outbound-report.ts";
import { SLUG, world, type World } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const hour = 3_600_000;
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function line(w: World): LineSnapshot {
  const db = new Database(join(dispatchState(w), "state.sqlite"));
  try {
    const row = db.query("SELECT line FROM tick_line WHERE id=1").get() as {
      line: string;
    };
    return JSON.parse(row.line) as LineSnapshot;
  } finally {
    db.close();
  }
}

test("a tick raises one host storage need until the fixture registry recovers", async () => {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [account(w, "a", "a@example.com")], {}, []);
  const store = join(w.home, ".local", "state", "jig", "test-fixtures-v1");
  for (const name of ["first", "second"])
    mkdirSync(join(store, name), { recursive: true });
  const tick = async () => {
    const result = await w.dispatch(["--json"], undefined, {
      JIG_TEST_FIXTURE_REGISTRY_LIMIT: "1",
    });
    expectSpawnExit(result, 0);
    return line(w).needs.filter((need) => need.cause === "state-storage");
  };
  const first = await tick();
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    repo: "host",
    act: "Investigate",
    reason: expect.stringContaining("2 of 1 registrations"),
  });
  expect((await tick())[0]?.since).toBe(first[0]?.since);
  rmdirSync(join(store, "second"));
  expect(await tick()).toHaveLength(0);
});

test("real ticks keep one low-quota need while it stands and withdraw it after balance recovery", async () => {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [account(w, "a", "a@example.com")], {}, []);
  const path = budgetPath(w.home);
  const now = Date.now();
  const store = sqliteBudgetStore(path);
  const governor = budgetGovernor(store);
  const window = (remaining: number) => ({
    limit: 3000,
    remaining,
    resetAt: now + hour,
    refillMs: hour,
    readAt: now,
  });
  governor.observe("linear:fixture", { complexity: window(100) });
  recordCall({
    path,
    system: "linear",
    credential: "linear:fixture",
    operation: "Queue",
    caller: "tick:before",
    cost: 5000,
    unit: "points",
    durationMs: 100,
    at: now,
  });
  const tick = async () => {
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    return line(w).needs.filter((n) => n.cause === "low-quota");
  };
  const first = await tick();
  expect(first).toHaveLength(1);
  expect(first[0]?.reason).toContain("Queue");
  const again = await tick();
  expect(again).toHaveLength(1);
  expect(again[0]?.since).toBe(first[0]?.since);
  // An answer after the balance recovers moves exhaustion beyond the refill horizon.
  governor.observe("linear:fixture", { complexity: window(3000) });
  expect(await tick()).toEqual([]);
});

test("real ticks keep one calls-failing need for a caller outside the tick whose calls all fail", async () => {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [account(w, "a", "a@example.com")], {}, []);
  const path = budgetPath(w.home);
  const now = Date.now();
  for (const credential of ["github:fresh-1", "github:fresh-2"])
    for (let i = 0; i < 12; i += 1)
      recordCall({
        path,
        system: "github",
        credential,
        operation: "GET /user",
        caller: "skill:example.ts",
        failure: "invalid",
        durationMs: 10,
        at: now,
      });
  // The tick's own failures are on its receipt, never a need of this kind.
  for (let i = 0; i < 30; i += 1)
    recordCall({
      path,
      system: "github",
      credential: "github:fresh-3",
      operation: "GET /user",
      caller: "tick:before",
      failure: "invalid",
      durationMs: 10,
      at: now,
    });
  const tick = async () => {
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    return line(w).needs.filter((n) => n.cause === "calls-failing");
  };
  const first = await tick();
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    repo: "host",
    act: "Investigate",
    target: "github skill:example.ts",
  });
  expect(first[0]?.reason).toContain("24 request(s)");
  const again = await tick();
  expect(again).toHaveLength(1);
  expect(again[0]?.since).toBe(first[0]?.since);
});

test("Linear headers reach the ledger and the quota projection with the same measured points", async () => {
  const w = world();
  current = w;
  const path = budgetPath(w.home);
  const store = sqliteBudgetStore(path);
  const governor = budgetGovernor(store);
  const now = Date.now();
  const fetcher = (async () =>
    Response.json(
      { data: { ok: true } },
      {
        headers: {
          "x-complexity": "200",
          "x-ratelimit-complexity-limit": "100",
          "x-ratelimit-complexity-remaining": "50",
          "x-ratelimit-complexity-reset": String(now + hour),
        },
      },
    )) as unknown as typeof fetch;
  await withLedgerPath(path, () =>
    withCaller("tick:linear", () =>
      httpTransport(
        "fixture-token",
        fetcher,
        governor,
      )("query Queue { viewer { id } }", {}),
    ),
  );
  const report = ledgerReport({ path, since: now - hour });
  expect(report.rows.map((r) => r.cost)).toEqual([200]);
  expect(report.rows[0]?.unit).toBe("points");
  expect(report.rows[0]?.caller).toBe("tick:linear");
  expect(quotaRisks(report, Date.now())[0]?.operations).toEqual(["Queue"]);
});

test("a tick reports GitHub's core and GraphQL balances from the machine's budget record", async () => {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [account(w, "a", "a@example.com")], {}, []);
  const now = Date.now();
  budgetGovernor(sqliteBudgetStore(budgetPath(w.home))).observe(
    "github:fixture",
    {
      requests: { limit: 5000, remaining: 3210, resetAt: now + hour },
      complexity: { limit: 5000, remaining: 4321, resetAt: now + hour },
    },
  );
  const r = await w.dispatch([]);
  expectSpawnExit(r, 0);
  expect(r.stdout).toContain(
    "outbound github: github:fixture: core 3210/5000, graphql 4321/5000",
  );
});
