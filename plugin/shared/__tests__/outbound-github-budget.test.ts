import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetGovernor,
  type BudgetRecord,
  budgetGovernor,
  memoryBudgetStore,
  parseRecord,
  sqliteBudgetStore,
} from "../outbound/budget.ts";
import {
  apiRoute,
  forgeAnswerOf,
  ghGovernance,
  githubCredential,
  limitsOf,
  setForgeGovernor,
  splitHeaders,
  withHeaders,
} from "../outbound/github-budget.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { ghRunFailure } from "../outbound/github.ts";
import { seededBudget } from "./outbound-budget-fixture.ts";
import { closeDatabase } from "../records/db.ts";
import { currentMs } from "../time.ts";
import { traceGhRunner } from "../trace.ts";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  held?: OutboundFailure;
}

const ENV = { GH_TOKEN: "test-forge-token" };
const KEY = githubCredential(ENV);
const directories: string[] = [];
const databases: string[] = [];

afterEach(() => {
  setForgeGovernor(null);
  for (const path of databases.splice(0)) closeDatabase(path);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-forge-budget-"));
  directories.push(dir);
  const path = join(dir, "budget.sqlite");
  databases.push(path);
  return path;
}

/** A forge client whose `gh` is `answer`, counting what it was asked to run. */
function client(answer: (argv: string[]) => Run): {
  run: (args: string[]) => Promise<Run>;
  sent: string[][];
} {
  const sent: string[][] = [];
  const runner = traceGhRunner<
    Run,
    { env?: Record<string, string>; timeoutSec?: number }
  >(
    async (argv) => {
      sent.push(argv);
      return answer(argv);
    },
    () => 10,
    { env: ENV },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: `${failure.reason}\n`,
      timedOut: false,
      held: failure,
    }),
  );
  return { run: (args) => runner(args, { env: ENV }), sent };
}

const ok = (stdout: string): Run => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

function headers(lines: Record<string, string | number>, status = "200 OK") {
  return `HTTP/2.0 ${status}\n${Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n\n`;
}

describe("GitHub's limits in the shared budget record", () => {
  it("holds the credential for another process after a secondary-limit answer, sending nothing before retry-after passes", async () => {
    const path = databasePath();
    // Two processes: each its own store over the machine's one database.
    const first = budgetGovernor(sqliteBudgetStore(path), {
      share: () => null,
    });
    setForgeGovernor(first);
    const refused = client(() => ({
      code: 1,
      stdout: `${headers({ "Retry-After": 120 }, "403 Forbidden")}{"message":"You have exceeded a secondary rate limit"}`,
      stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
      timedOut: false,
    }));
    const answered = await refused.run(["api", "repos/o/r/pulls"]);
    expect(ghRunFailure(answered)?.code).toBe("rate-limited");
    expect(answered.stdout).not.toStartWith("HTTP/");

    let offset = 0;
    const second = budgetGovernor(sqliteBudgetStore(path), {
      share: () => null,
      clock: () => currentMs() + offset,
    });
    setForgeGovernor(second);
    const other = client(() => ok("{}"));
    const held = await other.run(["pr", "view", "1", "--json", "title"]);
    expect(other.sent).toHaveLength(0);
    const failure = ghRunFailure(held);
    expect(failure?.code).toBe("rate-limited");
    expect(failure?.until).toBeGreaterThan(currentMs() + 100_000);
    expect(failure?.until).toBeLessThanOrEqual(currentMs() + 121_000);

    offset = 125_000;
    const after = await other.run(["pr", "view", "1", "--json", "title"]);
    expect(other.sent).toHaveLength(1);
    expect(after.code).toBe(0);
  });

  it("holds a refusal that names no wait for a minute, doubled for each refusal in a row, up to fifteen", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, { clock: () => now });
    const refusal: OutboundFailure = {
      code: "rate-limited",
      reason: "gh exited 1: secondary rate limit",
    };
    const holds: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      governor.observe(
        KEY,
        forgeAnswerOf(["pr", "list"], null, "", refusal, now),
      );
      const until = store.read(KEY)?.limitedUntil ?? 0;
      holds.push(until - now);
      now = until;
    }
    expect(holds).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
    governor.observe(KEY, forgeAnswerOf(["pr", "list"], null, "{}", null, now));
    expect(store.read(KEY)?.strikes).toBeUndefined();
  });

  it("reads a gh api answer's rate-limit headers into the record and gives the caller the body alone", async () => {
    const store = memoryBudgetStore();
    setForgeGovernor(budgetGovernor(store, { share: () => null }));
    const reset = Math.floor(currentMs() / 1000) + 1800;
    const forge = client((argv) =>
      ok(
        argv.includes("--include")
          ? `${headers({ "X-Ratelimit-Limit": 5000, "X-Ratelimit-Remaining": 4321, "X-Ratelimit-Reset": reset, "X-Ratelimit-Resource": "core" })}{"number":7}`
          : '{"number":7}',
      ),
    );
    const answer = await forge.run(["api", "repos/o/r/pulls/7"]);
    expect(forge.sent[0]).toEqual(["api", "repos/o/r/pulls/7", "--include"]);
    expect(answer.stdout).toBe('{"number":7}');
    expect(store.read(KEY)?.requests).toMatchObject({
      limit: 5000,
      remaining: 4321,
      resetAt: reset * 1000,
    });
  });

  it("adds no --include where the headers cannot be taken off, and keeps a caller's own", () => {
    expect(withHeaders(["api", "--paginate", "repos/o/r/pulls"], true)).toEqual(
      {
        argv: ["api", "--paginate", "repos/o/r/pulls"],
        strip: false,
      },
    );
    expect(withHeaders(["api", "-i", "user"], true)).toEqual({
      argv: ["api", "-i", "user"],
      strip: false,
    });
    expect(withHeaders(["api", "user"], false).strip).toBe(false);
    expect(withHeaders(["pr", "view", "1"], true).argv).toEqual([
      "pr",
      "view",
      "1",
    ]);
    expect(splitHeaders("plain").headers).toBeNull();
    expect(splitHeaders("HTTP/2.0 200 OK\r\nA: b\r\n\r\nbody").body).toBe(
      "body",
    );
  });

  it("takes every limit from the rate_limit endpoint, and the GraphQL balance from a query's rateLimit", () => {
    const reset = 1_800_000_000;
    const answer = forgeAnswerOf(
      ["api", "rate_limit"],
      null,
      JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 2600, reset },
          graphql: { limit: 5000, remaining: 4500, reset: reset + 60 },
          search: { limit: 30, remaining: 29, reset: reset - 3000 },
        },
      }),
      null,
      0,
    );
    expect(answer.requests).toEqual({
      limit: 5000,
      remaining: 2600,
      resetAt: reset * 1000,
    });
    expect(answer.complexity?.remaining).toBe(4500);
    expect(answer.windows?.search?.limit).toBe(30);
    const graphql = forgeAnswerOf(
      ["api", "graphql"],
      null,
      JSON.stringify({
        data: {
          rateLimit: {
            cost: 1,
            remaining: 4400,
            limit: 5000,
            resetAt: "2027-01-15T08:00:00Z",
          },
        },
      }),
      null,
      0,
    );
    expect(graphql.complexity?.remaining).toBe(4400);
  });

  it("names which limits each command spends", () => {
    expect(limitsOf(["api", "graphql"])).toEqual(["graphql"]);
    expect(limitsOf(["api", "/search/issues"])).toEqual(["search"]);
    expect(limitsOf(["api", "rate_limit"])).toEqual([]);
    expect(limitsOf(["api", "repos/o/r"])).toEqual(["core"]);
    expect(limitsOf(["pr", "view"])).toEqual(["core", "graphql"]);
    expect(limitsOf(["auth", "token"])).toBeNull();
  });
});

describe("the dispatcher's share of GitHub's windows", () => {
  const reset = 2_000_000;
  const record = (remaining: number): BudgetRecord => ({
    requests: { limit: 5000, remaining, resetAt: reset },
    complexity: { limit: 5000, remaining: 4900, resetAt: reset },
    limitedUntil: null,
    why: null,
    observedAt: 1_000_000,
  });
  const dispatcher = (store = memoryBudgetStore(), at = () => 1_000_000) => {
    const governor: BudgetGovernor = budgetGovernor(store, {
      clock: at,
      share: () => 0.5,
    });
    setForgeGovernor(governor);
    return { store, governor };
  };

  it("stops a REST call at its share of the core window and resumes at the reset", async () => {
    let now = 1_000_000;
    const { store } = dispatcher(memoryBudgetStore(), () => now);
    store.update(KEY, () => record(2500));
    const forge = client(() => ok("{}"));
    const stopped = await forge.run(["api", "repos/o/r/pulls"]);
    expect(forge.sent).toHaveLength(0);
    expect(ghRunFailure(stopped)).toMatchObject({
      code: "rate-limited",
      until: reset,
    });
    expect(stopped.stderr).toContain("dispatcher's share (50%)");

    now = reset + 1;
    const resumed = await forge.run(["api", "repos/o/r/pulls"]);
    expect(forge.sent).toHaveLength(1);
    expect(resumed.code).toBe(0);
  });

  it("reserves a request of the core window for each REST call it admits", async () => {
    const { store } = dispatcher();
    store.update(KEY, () => record(2502));
    const forge = client(() => ok("{}"));
    await forge.run(["api", "repos/o/r/pulls"]);
    await forge.run(["api", "repos/o/r/pulls"]);
    const third = await forge.run(["api", "repos/o/r/pulls"]);
    expect(forge.sent).toHaveLength(2);
    expect(ghRunFailure(third)?.code).toBe("rate-limited");
  });

  it("lets a GraphQL call and a rate_limit read through while only the core window is at its share", async () => {
    const { store } = dispatcher();
    store.update(KEY, () => record(100));
    const forge = client(() => ok("{}"));
    await forge.run([
      "api",
      "graphql",
      "-f",
      "query=query Q { viewer { login } }",
    ]);
    await forge.run(["api", "rate_limit"]);
    expect(forge.sent).toHaveLength(2);
    const view = await forge.run(["pr", "view", "1"]);
    expect(forge.sent).toHaveLength(2);
    expect(ghRunFailure(view)?.code).toBe("rate-limited");
  });
});

describe("what the record keeps of answers GitHub did not charge or that came in a burst", () => {
  const reset = 2_000_000;
  const record = (remaining: number): BudgetRecord => ({
    requests: { limit: 5000, remaining, resetAt: reset },
    complexity: { limit: 5000, remaining: 4900, resetAt: reset },
    limitedUntil: null,
    why: null,
    observedAt: 1_000_000,
  });

  it("reserves nothing for a conditional request, and lets a rate_limit answer replace the balance", async () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    setForgeGovernor(
      budgetGovernor(store, { clock: () => now, share: () => null }),
    );
    store.update(KEY, () => record(4000));
    const forge = client((argv) =>
      argv.includes("rate_limit")
        ? ok(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 4100, reset: reset / 1000 },
              },
            }),
          )
        : ok(""),
    );
    for (let i = 0; i < 5; i += 1)
      await forge.run(["api", "-i", "-H", 'If-None-Match: "abc"', "repos/o/r"]);
    expect(store.read(KEY)?.requests.remaining).toBe(4000);
    await forge.run(["api", "repos/o/r"]);
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
    now += 1000;
    await forge.run(["api", "rate_limit"]);
    expect(store.read(KEY)?.requests.remaining).toBe(4100);
  });

  it("gives back the reservation of a run that was never started", async () => {
    const store = memoryBudgetStore();
    setForgeGovernor(
      budgetGovernor(store, { clock: () => 1_000_000, share: () => null }),
    );
    store.update(KEY, () => record(4000));
    const forge = client(() => ({
      code: 1,
      stdout: "",
      stderr: "held",
      timedOut: false,
      held: { code: "unreachable", reason: "held earlier in this run" },
    }));
    await forge.run(["api", "repos/o/r"]);
    expect(store.read(KEY)?.requests.remaining).toBe(4000);
  });

  it("counts a burst of refusals already on their way as one, and a success sent before the hold does not clear it", () => {
    const store = memoryBudgetStore();
    const now = 1_000_000;
    const governor = budgetGovernor(store, { clock: () => now });
    const refused: OutboundFailure = {
      code: "rate-limited",
      reason: "gh exited 1: secondary rate limit",
    };
    const sentAt = now - 500;
    for (let i = 0; i < 5; i += 1)
      governor.observe(
        KEY,
        forgeAnswerOf(["pr", "list"], null, "", refused, now),
        sentAt,
      );
    expect(store.read(KEY)?.limitedUntil).toBe(now + 60_000);
    expect(store.read(KEY)?.strikes).toBe(1);
    governor.observe(
      KEY,
      forgeAnswerOf(["pr", "list"], null, "{}", null, now),
      sentAt,
    );
    expect(store.read(KEY)?.strikes).toBe(1);
    expect(store.read(KEY)?.limitedUntil).toBe(now + 60_000);
  });

  it("holds only the spent primary limit, so GraphQL calls go on while core waits for its reset", async () => {
    const store = memoryBudgetStore();
    setForgeGovernor(budgetGovernor(store, { share: () => null }));
    const resetSec = Math.floor(currentMs() / 1000) + 1800;
    const forge = client((argv) =>
      argv.includes("graphql")
        ? ok("{}")
        : {
            code: 1,
            stdout: `${headers({ "X-Ratelimit-Limit": 5000, "X-Ratelimit-Remaining": 0, "X-Ratelimit-Reset": resetSec, "X-Ratelimit-Resource": "core" }, "403 Forbidden")}{"message":"API rate limit exceeded"}`,
            stderr: "gh: API rate limit exceeded (HTTP 403)\n",
            timedOut: false,
          },
    );
    await forge.run(["api", "repos/o/r"]);
    expect(store.read(KEY)?.limitedUntil).toBeNull();
    const again = await forge.run(["api", "repos/o/r"]);
    expect(ghRunFailure(again)).toMatchObject({
      code: "rate-limited",
      until: resetSec * 1000,
    });
    await forge.run(["api", "graphql", "-f", "query=query Q { a }"]);
    expect(forge.sent.map((a) => a[1])).toEqual(["repos/o/r", "graphql"]);
  });

  it("finds the route after flags that come before it", () => {
    expect(
      limitsOf(["api", "-X", "GET", "--paginate", "--slurp", "search/issues"]),
    ).toEqual(["search"]);
    expect(apiRoute(["api", "-i", "-H", "Accept: x", "/rate_limit"])).toBe(
      "rate_limit",
    );
  });

  it("reads an absent rate-limit header as unknown, never as zero", () => {
    const answer = forgeAnswerOf(
      ["api", "user"],
      new Headers({
        "x-ratelimit-resource": "core",
        "x-ratelimit-reset": "1800000000",
      }),
      "{}",
      null,
      0,
    );
    expect(answer.requests).toBeUndefined();
  });
});

it("keeps the stored window when a rate_limit snapshot comes from a window that has since reset", () => {
  const store = memoryBudgetStore();
  const governor = budgetGovernor(store, { clock: () => 1_000_000 });
  governor.observe(KEY, {
    requests: { limit: 5000, remaining: 4990, resetAt: 5_000_000 },
  });
  governor.observe(KEY, {
    snapshot: true,
    requests: { limit: 5000, remaining: 12, resetAt: 900_000 },
  });
  expect(store.read(KEY)?.requests.remaining).toBe(4990);
});

describe("the accounting of runs whose answers say little of the balance", () => {
  const reset = 2_000_000;
  const record = (): BudgetRecord => ({
    requests: { limit: 5000, remaining: 4000, resetAt: reset },
    complexity: { limit: 5000, remaining: 4900, resetAt: reset },
    limitedUntil: null,
    why: null,
    observedAt: 1_000_000,
  });

  it("reserves a point of the GraphQL balance for a command that shows no headers", async () => {
    const store = memoryBudgetStore();
    setForgeGovernor(
      budgetGovernor(store, { clock: () => 1_000_000, share: () => null }),
    );
    store.update(KEY, record);
    const forge = client(() => ok("{}"));
    await forge.run(["pr", "view", "1"]);
    await forge.run(["pr", "view", "2"]);
    expect(store.read(KEY)?.complexity.remaining).toBe(4898);
    expect(store.read(KEY)?.requests.remaining).toBe(4000);
  });

  it("keeps reserving requests after the window it knew has reset, until an answer names the next", async () => {
    const store = memoryBudgetStore();
    let now = 3_000_000;
    setForgeGovernor(
      budgetGovernor(store, { clock: () => now, share: () => null }),
    );
    store.update(KEY, record);
    const forge = client(() => ok(""));
    await forge.run(["api", "--silent", "repos/o/r"]);
    now += 1000;
    await forge.run(["api", "--silent", "repos/o/r"]);
    const window = store.read(KEY)?.requests;
    expect(window?.remaining).toBe(4998);
    expect(window?.resetAt).toBe(3_000_000 + 3_600_000);
    expect(window?.estimated).toBe(true);
  });

  it("keeps spending recorded after a snapshot's request was sent", () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, { clock: () => 1_000_000 });
    store.update(KEY, () => ({
      ...record(),
      requests: {
        limit: 5000,
        remaining: 2500,
        resetAt: reset,
        readAt: 1_000_000,
        pending: [1_000_000],
      },
    }));
    governor.observe(
      KEY,
      {
        snapshot: true,
        requests: { limit: 5000, remaining: 2501, resetAt: reset },
      },
      999_000,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(2500);
    governor.observe(
      KEY,
      {
        snapshot: true,
        requests: { limit: 5000, remaining: 2501, resetAt: reset },
      },
      1_000_000 + 1,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(2501);
  });

  it("keeps the reservations made after a delayed snapshot's request, whatever the stored balance", () => {
    const store = memoryBudgetStore();
    let now = 1_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 2503, resetAt: reset, readAt: now },
    }));
    now += 10;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    now += 10;
    governor.admit("GitHub", KEY, { reserve: "requests" });
    now += 10;
    // Sent at 1_000_005, after spending outside Jig; both reservations postdate it.
    governor.observe(
      KEY,
      {
        snapshot: true,
        requests: { limit: 5000, remaining: 2501, resetAt: reset },
      },
      1_000_005,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(2499);
  });

  it("gives back an unsent request the snapshot did not count, even after an overlapping snapshot", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 10;
    const a = b.reserve();
    b.clock.now += 20;
    const second = b.reserve();
    b.clock.now += 10;
    b.snapshot(4000, b.clock.now - 15);
    expect(b.remaining()).toBe(3999);
    b.release(a);
    expect(b.remaining()).toBe(3999);
    b.release(second);
    expect(b.remaining()).toBe(4000);
  });

  it("gives nothing back for a request a later snapshot already settled", () => {
    const b = seededBudget(KEY, 4000, false);
    const sentAt = b.reserve();
    b.clock.now += 10;
    b.snapshot(4001, b.clock.now);
    b.clock.now += 10;
    b.release(sentAt);
    expect(b.remaining()).toBe(4001);
  });

  it("keeps a snapshot's settlement through an ordinary answer, so a later release gives nothing back", () => {
    const b = seededBudget(KEY, 4000, false);
    const sentAt = b.reserve();
    b.clock.now += 10;
    b.snapshot(4001, b.clock.now);
    b.clock.now += 10;
    b.answer(4000, b.clock.now - 1);
    b.clock.now += 10;
    b.release(sentAt);
    expect(b.remaining()).toBe(4000);
  });

  it("keeps an ordinary answer's lower balance when a delayed snapshot arrives", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 10;
    b.reserve();
    b.clock.now += 10;
    b.answer(0, b.clock.now - 1);
    b.clock.now += 10;
    b.snapshot(4000, 1_000_005);
    expect(b.remaining()).toBe(0);
  });

  it("keeps the reservations an ordinary answer's retained balance counted, so a release still gives one back", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 10;
    const sentAt = b.reserve();
    b.clock.now += 10;
    b.answer(4000, 1_000_005);
    b.clock.now += 10;
    b.snapshot(4000, 1_000_015);
    expect(b.remaining()).toBe(3999);
    b.release(sentAt);
    expect(b.remaining()).toBe(4000);
  });

  it("gives nothing back for a reservation an ordinary answer's lower balance outlasts a delayed snapshot", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 10;
    const sentAt = b.reserve();
    b.clock.now += 10;
    b.answer(0, b.clock.now - 1);
    b.clock.now += 10;
    b.snapshot(4000, 1_000_015);
    b.release(sentAt);
    expect(b.remaining()).toBe(0);
  });

  it("keeps a reservation made after an ordinary answer's request was sent, for a later snapshot to subtract", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 10;
    b.reserve();
    b.clock.now += 10;
    b.answer(3990, 1_000_005);
    b.clock.now += 10;
    b.snapshot(3990, 1_000_005);
    expect(b.remaining()).toBe(3989);
  });

  it("deducts a reservation made after an ordinary answer's request was sent, so releasing it gives back only that one", () => {
    const b = seededBudget(KEY, 4000);
    b.clock.now += 5;
    const sentAt = b.reserve();
    b.clock.now += 5;
    const unsentAt = b.reserve();
    b.clock.now += 10;
    b.answer(0, sentAt);
    expect(b.remaining()).toBe(0);
    b.release(unsentAt);
    expect(b.remaining()).toBe(0);
  });

  it("reads a stored window with a negative or fractional overflow count as none", () => {
    const window = { limit: 5000, remaining: 4000, resetAt: 2_000_000 };
    const text = (overflow: unknown) =>
      JSON.stringify({
        requests: { ...window, overflow },
        complexity: { limit: null, remaining: null, resetAt: null },
        limitedUntil: null,
        why: null,
        observedAt: 1,
      });
    expect(parseRecord(text({ count: -5000, at: 5 }))).toBeNull();
    expect(parseRecord(text({ count: 1.5, at: 5 }))).toBeNull();
    expect(parseRecord(text({ count: 2, at: -1 }))).toBeNull();
    expect(parseRecord(text({ count: 2, at: 5 }))).not.toBeNull();
  });

  it("never credits a reservation the cap forgot", () => {
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
    for (let i = 0; i < 300; i += 1) {
      now += 1;
      governor.admit("GitHub", KEY, { reserve: "requests" });
    }
    governor.observe(
      KEY,
      {
        snapshot: true,
        requests: { limit: 5000, remaining: 4000, resetAt: reset },
      },
      1_000_000,
    );
    expect(store.read(KEY)?.requests.remaining).toBe(3700);
  });

  it("releases one reservation of several made in the same millisecond", () => {
    const store = memoryBudgetStore();
    const governor = budgetGovernor(store, {
      clock: () => 1_000_000,
      share: () => null,
    });
    store.update(KEY, () => ({
      ...record(),
      requests: { limit: 5000, remaining: 4000, resetAt: reset, readAt: 1 },
    }));
    const a = governor.admit("GitHub", KEY, { reserve: "requests" });
    const b = governor.admit("GitHub", KEY, { reserve: "requests" });
    expect(store.read(KEY)?.requests.remaining).toBe(3998);
    governor.release?.(KEY, "requests", a);
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
    governor.release?.(KEY, "requests", b);
    expect(store.read(KEY)?.requests.remaining).toBe(4000);
  });

  it("does not let an answer from an ended window replace a guessed reset", async () => {
    const store = memoryBudgetStore();
    let now = 3_000_000;
    const governor = budgetGovernor(store, {
      clock: () => now,
      share: () => null,
    });
    store.update(KEY, record);
    governor.admit("GitHub", KEY, {
      reserve: "requests",
      rollMs: 3_600_000,
    });
    const rolled = store.read(KEY)?.requests;
    expect(rolled?.estimated).toBe(true);
    now += 1000;
    governor.observe(KEY, {
      requests: { limit: 5000, remaining: 4000, resetAt: reset },
    });
    expect(store.read(KEY)?.requests).toEqual(rolled);
  });

  it("reserves a conditional request whose answer's headers are not read", async () => {
    const store = memoryBudgetStore();
    setForgeGovernor(
      budgetGovernor(store, { clock: () => 1_000_000, share: () => null }),
    );
    store.update(KEY, record);
    const forge = client(() => ok(""));
    await forge.run(["api", "--silent", "-H", "If-None-Match: x", "repos/o/r"]);
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
  });

  it("reserves a conditional request with its own --include when the output is not captured", () => {
    const store = memoryBudgetStore();
    setForgeGovernor(
      budgetGovernor(store, { clock: () => 1_000_000, share: () => null }),
    );
    store.update(KEY, record);
    ghGovernance(["api", "-i", "-H", "If-None-Match: x", "repos/o/r"], {
      env: ENV,
      captured: false,
    })?.admit();
    expect(store.read(KEY)?.requests.remaining).toBe(3999);
  });

  it("keys a cloud or local tenancy host by GH_TOKEN, like github.com", () => {
    const a = githubCredential({ GH_HOST: "team.ghe.com", GH_TOKEN: "one" });
    const b = githubCredential({ GH_HOST: "team.ghe.com", GH_TOKEN: "two" });
    expect(a).not.toBe(b);
    expect(
      githubCredential({ GH_HOST: "x.github.localhost", GH_TOKEN: "one" }),
    ).not.toBe(
      githubCredential({ GH_HOST: "x.github.localhost", GH_TOKEN: "two" }),
    );
  });

  it("keys Enterprise credentials by the Enterprise token the client uses", () => {
    const one = githubCredential({
      GH_HOST: "ghe.example.com",
      GH_ENTERPRISE_TOKEN: "one",
    });
    const two = githubCredential({
      GH_HOST: "ghe.example.com",
      GH_ENTERPRISE_TOKEN: "two",
    });
    expect(one).not.toBe(two);
    expect(
      githubCredential({ GH_HOST: "ghe.example.com", GH_TOKEN: "x" }),
    ).not.toBe(githubCredential({ GH_TOKEN: "x" }));
  });
});

describe("what a refusal holds and what its caller is told", () => {
  const now = 1_000_000;
  const spent = () =>
    new Headers({
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String((now + 600_000) / 1000),
    });
  const refused = (text: string, headers: Headers) =>
    forgeAnswerOf(
      ["api", "repos/o/r"],
      headers,
      "{}",
      ghRunFailure({ code: 1, stderr: text, timedOut: false }),
      now,
      text,
    );

  it("holds only the window of a primary refusal, and the credential for a secondary one with the same headers", () => {
    const primary = refused("gh: API rate limit exceeded (HTTP 403)", spent());
    expect(primary.limitedUntil).toBeUndefined();
    expect(primary.unnamedRefusal).toBeUndefined();
    const secondary = refused(
      "gh: You have exceeded a secondary rate limit (HTTP 403)",
      spent(),
    );
    expect(secondary.unnamedRefusal).toBeDefined();
  });

  it("holds the credential when the resource reported has no window an admission checks", () => {
    const headers = spent();
    headers.set("x-ratelimit-resource", "code_search");
    const answer = refused("gh: API rate limit exceeded (HTTP 403)", headers);
    expect(answer.limitedUntil).toBe(now + 600_000);
  });

  it("tells the caller of a refusal how long the record holds the credential", async () => {
    setForgeGovernor(
      budgetGovernor(memoryBudgetStore(), { share: () => null }),
    );
    const forge = client(() => ({
      code: 1,
      stdout: `${headers({ "Retry-After": 120 }, "403 Forbidden")}{}`,
      stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
      timedOut: false,
    }));
    const answered = await forge.run(["api", "repos/o/r/pulls"]);
    const until = ghRunFailure(answered)?.until ?? 0;
    expect(until).toBeGreaterThan(currentMs() + 100_000);
    expect(until).toBeLessThanOrEqual(currentMs() + 121_000);
  });

  it("reads JIG_FORGE_BUDGET from the environment the run is given", () => {
    expect(
      ghGovernance(["api", "user"], {
        env: { ...ENV, JIG_FORGE_BUDGET: "off" },
        captured: true,
      }),
    ).toBeNull();
    expect(
      ghGovernance(["api", "user"], { env: { ...ENV }, captured: true }),
    ).not.toBeNull();
  });
});
