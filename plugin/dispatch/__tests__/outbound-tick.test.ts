import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
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
