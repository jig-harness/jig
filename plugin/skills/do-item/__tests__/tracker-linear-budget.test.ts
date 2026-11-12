import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  budgetGovernor,
  credentialKey,
  budgetPath,
  memoryBudgetStore,
  sqliteBudgetStore,
  TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import {
  cliTransport,
  httpTransport,
  linearAnswer,
} from "../scripts/lib/tracker/linear-transport.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "linear-budget-process.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const headers = (remaining: number, reset: number) => ({
  "x-ratelimit-requests-limit": "2500",
  "x-ratelimit-requests-remaining": String(remaining),
  "x-ratelimit-requests-reset": String(reset),
  "x-ratelimit-complexity-limit": "3000000",
  "x-ratelimit-complexity-remaining": "2900000",
  "x-ratelimit-complexity-reset": String(reset),
});

function counting(answer: () => Response) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const refusal = (reset: number) =>
  new Response(
    JSON.stringify({
      errors: [
        { message: "Rate limited", extensions: { code: "RATELIMITED" } },
      ],
    }),
    { status: 400, headers: headers(0, reset) },
  );

describe("the Linear transport's request budget", () => {
  it("reads both windows from an answer, and a RATELIMITED refusal until the spent window's reset", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const reset = now + 20 * 60_000;
    const read = linearAnswer(new Headers(headers(1200, reset)), 200, {}, now);
    expect(read).toEqual({
      requests: {
        limit: 2500,
        remaining: 1200,
        resetAt: reset,
        refillMs: 3_600_000,
      },
      complexity: {
        limit: 3_000_000,
        remaining: 2_900_000,
        resetAt: reset,
        refillMs: 3_600_000,
      },
    });
    const refused = linearAnswer(
      new Headers(headers(0, reset)),
      400,
      { errors: [{ extensions: { code: "RATELIMITED" } }] },
      now,
    );
    expect(refused.limitedUntil).toBe(reset);
  });

  it("sends nothing after a refusal until the reset it named, then sends again", async () => {
    let now = Date.now();
    const reset = now + 30 * 60_000;
    const governor = budgetGovernor(memoryBudgetStore(), {
      clock: () => now,
      share: () => null,
    });
    let refuse = true;
    const { calls, fetchImpl } = counting(() =>
      refuse
        ? refusal(reset)
        : new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: headers(2499, reset + 3_600_000),
          }),
    );
    const transport = httpTransport("lin_api_a", fetchImpl, governor);
    await expect(transport("query { a }", {})).rejects.toBeInstanceOf(
      TrackerRateLimited,
    );
    expect(calls.n).toBe(1);
    refuse = false;
    for (let i = 0; i < 5; i++) {
      const error = await transport("query { a }", {}).catch((e) => e);
      expect(error).toBeInstanceOf(TrackerRateLimited);
      expect((error as TrackerRateLimited).resetAt).toBe(reset);
    }
    expect(calls.n).toBe(1);
    now = reset + 1;
    expect(await transport("query { a }", {})).toEqual({ ok: true });
    expect(calls.n).toBe(2);
  });

  it("keeps the dispatcher to its share of the window and lets a pass use the rest", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const store = memoryBudgetStore();
    const key = credentialKey("linear", "lin_api_b");
    const pass = budgetGovernor(store, { clock: () => now, share: () => null });
    pass.observe(key, {
      requests: { limit: 2500, remaining: 1200, resetAt: now + 60_000 },
    });
    const dispatcher = budgetGovernor(store, {
      clock: () => now,
      share: () => 0.5,
    });
    expect(() => dispatcher.admit("linear", key)).toThrow(/share \(50%\)/);
    expect(() => pass.admit("linear", key)).not.toThrow();
  });

  it("lets the dispatcher send again once a continuously refilling window refills past its share", () => {
    let now = Date.parse("2026-11-10T12:00:00Z");
    const store = memoryBudgetStore();
    const key = credentialKey("linear", "lin_api_c");
    const dispatcher = budgetGovernor(store, {
      clock: () => now,
      share: () => 0.5,
    });
    // The answer left 1,240 of 2,500; the reset it names is an hour of refill away.
    dispatcher.observe(key, {
      requests: {
        limit: 2500,
        remaining: 1240,
        resetAt: now + 3_600_000,
        refillMs: 3_600_000,
      },
    });
    const refused = (() => {
      try {
        dispatcher.admit("linear", key);
        return null;
      } catch (error) {
        return error as TrackerRateLimited;
      }
    })();
    expect(refused).toBeInstanceOf(TrackerRateLimited);
    // 11 requests refill in about 16 seconds, not an hour.
    expect((refused as TrackerRateLimited).resetAt - now).toBeLessThan(20_000);
    now += 20_000;
    expect(() => dispatcher.admit("linear", key)).not.toThrow();
  });

  it("keeps a window that resets whole walled until its reset", () => {
    let now = Date.parse("2026-11-10T12:00:00Z");
    const store = memoryBudgetStore();
    const key = credentialKey("linear", "lin_api_d");
    const dispatcher = budgetGovernor(store, {
      clock: () => now,
      share: () => 0.5,
    });
    dispatcher.observe(key, {
      requests: { limit: 2500, remaining: 1240, resetAt: now + 3_600_000 },
    });
    now += 20_000;
    expect(() => dispatcher.admit("linear", key)).toThrow(/share \(50%\)/);
  });

  it("records a refusal the command-line client reports, for the fallback period", async () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, { share: () => null });
    const bin = join(mkdtempSync(join(tmpdir(), "linear-cli-")), "linear");
    dirs.push(join(bin, ".."));
    await Bun.write(
      bin,
      `#!/bin/sh\necho '{"errors":[{"message":"limited","extensions":{"code":"RATELIMITED"}}]}'\nexit 1\n`,
    );
    const { chmodSync } = await import("node:fs");
    chmodSync(bin, 0o755);
    const transport = cliTransport(bin, governor);
    await expect(transport("query { a }", {})).rejects.toBeInstanceOf(
      TrackerRateLimited,
    );
    const record = store.read(credentialKey("linear", `cli:${bin}`));
    expect(record?.limitedUntil).toBeGreaterThan(Date.now());
  });

  it("ends a claim the limit refuses with exit 5 and the reset, sending nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "linear-claim-home-"));
    dirs.push(home);
    const token = "lin_api_claim";
    const reset = Date.now() + 20 * 60_000;
    budgetGovernor(sqliteBudgetStore(budgetPath(home)), {
      share: () => null,
    }).observe(credentialKey("linear", token), {
      limitedUntil: reset,
      why: "Linear refused the request (HTTP 400, RATELIMITED)",
    });
    const overlay = join(home, "overlay.yaml");
    await Bun.write(
      overlay,
      "issue_tracker:\n  adapter: linear\n  team: ENG\n",
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/tracker.ts"),
        "claim",
        "ENG-4",
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          JIG_OVERLAY: overlay,
          JIG_USER_LAYER: "off",
          LINEAR_API_KEY: token,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(child, 5);
    expect(child.stderr.toString()).toContain(
      `RATE-LIMITED until ${new Date(reset).toISOString()}`,
    );
  });

  it("refuses across processes: a second process sends nothing before the reset the first was told", () => {
    const dir = mkdtempSync(join(tmpdir(), "linear-budget-"));
    dirs.push(dir);
    const store = join(dir, "budget.sqlite");
    const reset = Date.now() + 10 * 60_000;
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(["bun", FIXTURE, store, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(r, 0);
      return JSON.parse(r.stdout.toString()) as {
        fetches: number;
        ended: string;
      };
    };
    expect(run("refuse", String(reset))).toEqual({
      fetches: 1,
      ended: `limited ${reset}`,
    });
    expect(run("answer", String(reset))).toEqual({
      fetches: 0,
      ended: `limited ${reset}`,
    });
    expect(run("answer", String(reset), String(reset + 1))).toEqual({
      fetches: 1,
      ended: "answered",
    });
  });

  it("reserves each admitted request, so concurrent callers spend the balance once", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const store = memoryBudgetStore();
    const key = credentialKey("linear", "lin_api_r");
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => 0.5,
    });
    governor.observe(key, {
      requests: { limit: 2500, remaining: 1251, resetAt: now + 60_000 },
    });
    expect(() => governor.admit("linear", key)).not.toThrow();
    expect(() => governor.admit("linear", key)).toThrow(/share \(50%\)/);
  });

  it("keeps the newer window when a delayed answer from the older one arrives", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const store = memoryBudgetStore();
    const key = credentialKey("linear", "lin_api_o");
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    governor.observe(key, {
      requests: { limit: 2500, remaining: 2400, resetAt: now + 3_600_000 },
    });
    governor.observe(key, {
      requests: { limit: 2500, remaining: 10, resetAt: now + 1_000 },
    });
    expect(store.read(key)?.requests.resetAt).toBe(now + 3_600_000);
  });

  it("reads a damaged stored record as none", () => {
    const home = mkdtempSync(join(tmpdir(), "linear-damaged-"));
    dirs.push(home);
    const path = budgetPath(home);
    const store = sqliteBudgetStore(path);
    const key = credentialKey("linear", "lin_api_d");
    store.update(key, () => ({
      requests: { limit: null, remaining: null, resetAt: null },
      complexity: { limit: null, remaining: null, resetAt: null },
      limitedUntil: null,
      why: null,
      observedAt: 1,
    }));
    expect(store.read(key)).not.toBeNull();
    const { Database } = require("bun:sqlite");
    const db = new Database(path);
    db.query("UPDATE tracker_budget SET value = '{}' WHERE key = ?").run(key);
    db.close();
    expect(store.read(key)).toBeNull();
    expect(() =>
      budgetGovernor(store, { share: () => 0.5 }).admit("linear", key),
    ).not.toThrow();
  });
});
