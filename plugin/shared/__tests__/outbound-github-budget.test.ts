import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetGovernor,
  type BudgetRecord,
  budgetGovernor,
  memoryBudgetStore,
  sqliteBudgetStore,
} from "../outbound/budget.ts";
import {
  apiRoute,
  forgeAnswerOf,
  githubCredential,
  limitsOf,
  setForgeGovernor,
  splitHeaders,
  withHeaders,
} from "../outbound/github-budget.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { ghRunFailure } from "../outbound/github.ts";
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
    setForgeGovernor(
      budgetGovernor(store, { clock: () => 1_000_000, share: () => null }),
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
