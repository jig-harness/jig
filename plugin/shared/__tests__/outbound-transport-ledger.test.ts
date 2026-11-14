import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpTransport as linearTransport } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import {
  budgetGovernor,
  credentialKey,
  memoryBudgetStore,
  sqliteBudgetStore,
} from "../outbound/budget.ts";
import {
  ledgerReport,
  withCaller,
  withLedgerPath,
  withLedgerWriter,
  type CallRecord,
} from "../outbound/ledger.ts";
import { httpTransport as githubTransport } from "../../skills/do-item/scripts/lib/tracker/github/transport.ts";
import { httpTransport as jiraTransport } from "../../skills/do-item/scripts/lib/tracker/jira/transport.ts";
import { ok } from "../outcome.ts";
import { traceGhRunner } from "../trace.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("outbound transport cost accounting", () => {
  it("totals each named Linear operation from its cost header, including local refusals separately", async () => {
    const events: CallRecord[] = [];
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, { share: () => null });
    const token = "test-cost-key";
    let n = 0;
    const reset = Date.now() + 3_600_000;
    const fetchImpl = (async () => {
      n += 1;
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: {
          "x-complexity": String(n * 12),
          "x-ratelimit-complexity-limit": "1000",
          "x-ratelimit-complexity-remaining": String(
            1000 - (n === 1 ? 12 : 36),
          ),
          "x-ratelimit-complexity-reset": String(reset),
        },
      });
    }) as unknown as typeof fetch;
    await withLedgerWriter(
      (event) => events.push(event),
      async () => {
        const transport = linearTransport(token, fetchImpl, governor);
        await transport("query FirstOperation { ok }", {});
        await transport("query SecondOperation { ok }", {});
        governor.observe(credentialKey("linear", token), {
          limitedUntil: reset,
        });
        await expect(
          transport("query HeldOperation { ok }", {}),
        ).rejects.toThrow();
      },
    );
    expect(events.map((e) => e.operation)).toEqual([
      "FirstOperation",
      "SecondOperation",
      "HeldOperation",
    ]);
    expect(events.map((e) => e.cost)).toEqual([12, 24, null]);
    expect(events.map((e) => e.requests)).toEqual([1, 1, 0]);
    expect(events[2]?.failure).toBe("rate-limited");
    expect(
      events.every((e) => e.credential === credentialKey("linear", token)),
    ).toBe(true);
    expect(events.every((e) => !JSON.stringify(e).includes(token))).toBe(true);
    const held = store.read(credentialKey("linear", token))?.complexity
      .remaining;
    expect(held).toBeDefined();
    expect(Math.abs(1000 - (held ?? 0) - 36)).toBeLessThan(1);
  });

  it("records GraphQL points through HTTP and the shared gh boundary without retaining inputs", async () => {
    const events: CallRecord[] = [];
    await withLedgerWriter(
      (event) => events.push(event),
      async () => {
        const transport = githubTransport(
          "https://api.example.test/graphql",
          "private-test-key",
          (async () =>
            new Response(
              JSON.stringify({ data: { rateLimit: { cost: 7 } } }),
            )) as unknown as typeof fetch,
        );
        await transport("query PublicOperation { rateLimit { cost } }", {
          privateInput: "private-value",
        });
        const runner = traceGhRunner(
          async () => ({
            code: 0,
            stdout: JSON.stringify({ data: { rateLimit: { cost: 9 } } }),
            stderr: "",
            timedOut: false,
          }),
          () => 10,
          {},
          () => {
            throw new Error("unexpected hold");
          },
        );
        await runner([
          "api",
          "graphql",
          "-f",
          "query=query SecondPublicOperation { rateLimit { cost } }",
        ]);
      },
    );
    expect(events.map((event) => event.operation)).toEqual([
      "PublicOperation",
      "SecondPublicOperation",
    ]);
    expect(events.map((event) => event.cost)).toEqual([7, 9]);
    expect(events.map((event) => event.estimated)).toEqual([false, false]);
    expect(events.map((event) => event.unit)).toEqual(["points", "points"]);
    expect(events.map((event) => event.requests)).toEqual([1, 1]);
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it("keeps opaque forge command estimates in request units and excludes local authentication", async () => {
    const events: CallRecord[] = [];
    await withLedgerWriter(
      (event) => events.push(event),
      async () => {
        const runner = traceGhRunner(
          async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
          () => 10,
          {},
          () => {
            throw new Error("unexpected hold");
          },
        );
        await runner([
          "api",
          "repos/private-owner/private-repo/issues/123?cursor=private-value",
        ]);
        await runner(["auth", "token"]);
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "GET /repos/{}/{}/issues/{}",
      requests: 1,
      cost: 1,
      unit: "requests",
      estimated: true,
    });
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it("records each Jira credential renewal attempt and body-read failure with a safe route", async () => {
    const events: CallRecord[] = [];
    const authorization = {
      header: async () => ok("Bearer first-private-key"),
      lease: async () => ({
        header: ok("Bearer first-private-key"),
        renew: async () => ok("Bearer second-private-key"),
        settleRenewal: () => undefined,
        refuseRenewal: () => undefined,
      }),
    };
    let calls = 0;
    await withLedgerWriter(
      (event) => events.push(event),
      async () => {
        const transport = jiraTransport(
          "https://tracker.example.test",
          authorization,
          (async () => {
            calls += 1;
            return new Response("{}", { status: calls === 1 ? 401 : 200 });
          }) as unknown as typeof fetch,
        );
        expect(
          await transport({ method: "GET", path: "issue/PRIVATE-123" }),
        ).toEqual({});
        const lost = jiraTransport(
          "https://tracker.example.test",
          authorization,
          (async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("connection reset"));
                },
              }),
            )) as unknown as typeof fetch,
        );
        await expect(
          lost({
            method: "POST",
            path: "issue/PRIVATE-123/comment",
            body: { privateText: "private-value" },
          }),
        ).rejects.toThrow("answer lost");
      },
    );
    expect(events.map((event) => event.failure)).toEqual([
      "unauthorized",
      null,
      "unreachable",
    ]);
    expect(events.map((event) => event.requests)).toEqual([1, 1, 1]);
    expect(events.map((event) => event.operation)).toEqual([
      "GET /issue/{}",
      "GET /issue/{}",
      "POST /issue/{}/comment",
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(JSON.stringify(events)).not.toContain("PRIVATE-");
  });

  it("reconciles a tick's real Linear ledger rows with the shared budget database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbound-cost-integration-"));
    directories.push(directory);
    const path = join(directory, "budget.sqlite");
    const governor = budgetGovernor(sqliteBudgetStore(path), {
      share: () => null,
    });
    const resetAt = Date.now() + 3_600_000;
    const token = "integration-cost-key";
    governor.observe(credentialKey("linear", token), {
      complexity: {
        limit: 1000,
        remaining: 1000,
        resetAt,
        refillMs: 3_600_000,
      },
    });
    await withLedgerPath(path, () =>
      withCaller("tick:test-cost-run", async () => {
        const transport = linearTransport(
          token,
          (async () =>
            new Response(JSON.stringify({ data: { ok: true } }), {
              headers: {
                "x-complexity": "120",
                "x-ratelimit-complexity-limit": "1000",
                "x-ratelimit-complexity-remaining": "880",
                "x-ratelimit-complexity-reset": String(resetAt),
              },
            })) as unknown as typeof fetch,
          governor,
        );
        await transport("query TickCostOperation { ok }", {});
        const report = ledgerReport({ caller: "tick:test-cost-run" });
        expect(report.unavailable).toBeUndefined();
        expect(report.rows).toHaveLength(1);
        expect(report.rows[0]).toMatchObject({
          operation: "TickCostOperation",
          caller: "tick:test-cost-run",
          cost: 120,
          requests: 1,
          unit: "points",
          unknownCost: 0,
          estimated: 0,
        });
        const remaining = report.balances[0]?.record.complexity.remaining;
        expect(remaining).not.toBeNull();
        expect(
          Math.abs(
            1000 -
              (remaining ?? 0) -
              report.rows.reduce((sum, row) => sum + row.cost, 0),
          ),
        ).toBeLessThan(1);
      }),
    );
  });

  it("keeps Linear's reported complexity when the body is lost after its headers", async () => {
    const events: CallRecord[] = [];
    await withLedgerWriter(
      (event) => events.push(event),
      async () => {
        const transport = linearTransport(
          "body-lost-key",
          (async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("connection reset"));
                },
              }),
              { headers: { "x-complexity": "31" } },
            )) as unknown as typeof fetch,
        );
        await expect(
          transport("mutation LostBodyOperation { ok }", {}),
        ).rejects.toThrow("response lost");
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "LostBodyOperation",
      cost: 31,
      requests: 1,
      failure: "unreachable",
      estimated: false,
      unit: "points",
    });
  });
});
