/**
 * A GitHub GraphQL request sent over HTTPS (`JIG_GITHUB_GRAPHQL_URL`) keeps to
 * the same budget record as a run of `gh` signed in with the same token: it
 * is admitted against it, and what its answer says is recorded there.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetGovernor,
  sqliteBudgetStore,
} from "../../../shared/outbound/budget.ts";
import {
  githubCredential,
  setForgeGovernor,
} from "../../../shared/outbound/github-budget.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import type { OutboundFailure } from "../../../shared/outbound/failure.ts";
import { closeDatabase } from "../../../shared/records/db.ts";
import { currentMs } from "../../../shared/time.ts";
import { traceGhRunner } from "../../../shared/trace.ts";
import {
  GitHubApiError,
  httpTransport,
} from "../scripts/lib/tracker/github/transport.ts";
import { GitHubClient } from "../../reflect/scripts/lib/github/api.ts";

const TOKEN = "https-budget-token";
const ENV = { GH_TOKEN: TOKEN };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  held?: OutboundFailure;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  setForgeGovernor(null);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The machine's one budget database, which each simulated process opens a store over. */
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-https-budget-"));
  const path = join(dir, "budget.sqlite");
  cleanups.push(() => {
    closeDatabase(path);
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

/** A stub GitHub GraphQL endpoint answering every request with `answer`, counting them. */
function stubServer(answer: () => Response): {
  url: string;
  hits: () => number;
} {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      hits += 1;
      return answer();
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/graphql`, hits: () => hits };
}

/** A forge client signed in with the same token, whose `gh` answers `{}` and counts what it was asked to run. */
function ghClient(): {
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
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
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

const QUERY = "query Viewer { viewer { login } }";

describe("a GitHub request over HTTPS in the shared budget record", () => {
  it("holds a gh call in another process after the refusal it met, until its retry-after passes", async () => {
    const path = databasePath();
    const server = stubServer(
      () =>
        new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit.",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": "120",
            },
          },
        ),
    );
    // Two processes: each its own store over the machine's one database.
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    const refused = await httpTransport(server.url, TOKEN)(
      QUERY,
      {},
      undefined,
      true,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(GitHubApiError);
    expect((refused as GitHubApiError).code).toBe("rate-limited");
    expect(server.hits()).toBe(1);

    let offset = 0;
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), {
        share: () => null,
        clock: () => currentMs() + offset,
      }),
    );
    const gh = ghClient();
    const held = await gh.run(["pr", "view", "1", "--json", "title"]);
    expect(gh.sent).toHaveLength(0);
    const failure = ghRunFailure(held);
    expect(failure?.code).toBe("rate-limited");
    expect(failure?.until).toBeGreaterThan(currentMs() + 100_000);
    expect(failure?.until).toBeLessThanOrEqual(currentMs() + 121_000);

    offset = 125_000;
    expect((await gh.run(["pr", "view", "1", "--json", "title"])).code).toBe(0);
    expect(gh.sent).toHaveLength(1);
  });

  it("sends nothing while a gh call's refusal holds the token, answering with the wait the record names", async () => {
    const path = databasePath();
    const server = stubServer(() =>
      Response.json({ data: { viewer: { login: "x" } } }),
    );
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    const store = sqliteBudgetStore(path);
    const until = currentMs() + 300_000;
    store.update(githubCredential(ENV), () => ({
      requests: { limit: null, remaining: null, resetAt: null },
      complexity: { limit: null, remaining: null, resetAt: null },
      limitedUntil: until,
      why: "GitHub refused the credential: secondary rate limit",
      observedAt: currentMs(),
    }));
    const refused = await httpTransport(server.url, TOKEN)(
      QUERY,
      {},
      undefined,
      true,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(GitHubApiError);
    expect((refused as GitHubApiError).code).toBe("rate-limited");
    expect((refused as GitHubApiError).until).toBe(until);
    expect(server.hits()).toBe(0);
  });

  it("records the GraphQL balance an answer's headers report, reserving a point before it is sent", async () => {
    const path = databasePath();
    const reset = Math.floor(currentMs() / 1000) + 1800;
    const server = stubServer(() =>
      Response.json(
        { data: { viewer: { login: "x" } } },
        {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4321",
            "x-ratelimit-reset": String(reset),
          },
        },
      ),
    );
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    const transport = httpTransport(server.url, TOKEN);
    expect(await transport(QUERY, {}, undefined, true)).toEqual({
      viewer: { login: "x" },
    });
    const record = sqliteBudgetStore(path).read(githubCredential(ENV));
    expect(record?.complexity).toMatchObject({
      limit: 5000,
      remaining: 4321,
      resetAt: reset * 1000,
    });
    // The next request reserves a point of the balance before it leaves.
    await transport(QUERY, {}, undefined, true);
    expect(server.hits()).toBe(2);
    expect(
      sqliteBudgetStore(path).read(githubCredential(ENV))?.complexity.remaining,
    ).toBe(4320);
  });

  it("tells a reflection-store write the record refused that nothing was sent", async () => {
    const path = databasePath();
    const server = stubServer(() => Response.json({ data: {} }));
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    sqliteBudgetStore(path).update(githubCredential(ENV), () => ({
      requests: { limit: null, remaining: null, resetAt: null },
      complexity: { limit: 5000, remaining: 0, resetAt: currentMs() + 600_000 },
      limitedUntil: null,
      why: null,
      observedAt: currentMs(),
    }));
    const client = new GitHubClient({
      transport: httpTransport(server.url, TOKEN),
      intervalMs: 0,
    });
    const refused = await client
      .write("mutation Add { addComment { clientMutationId } }", {})
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(GitHubApiError);
    expect((refused as GitHubApiError).code).toBe("rate-limited");
    expect((refused as GitHubApiError).sent).toBe(false);
    expect((refused as GitHubApiError).message).not.toContain(
      "may have been applied",
    );
    expect(server.hits()).toBe(0);
  });

  it("holds the credential on a refusal whose body could not be read, from the headers it did send", async () => {
    const path = databasePath();
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    let sends = 0;
    const lostBody = (async () => {
      sends += 1;
      const res = new Response("", {
        status: 429,
        headers: { "retry-after": "120" },
      });
      Object.defineProperty(res, "text", {
        value: () => Promise.reject(new Error("socket closed")),
      });
      return res;
    }) as unknown as typeof fetch;
    const refused = await httpTransport(
      "https://github.example/graphql",
      TOKEN,
      lostBody,
    )(QUERY, {}, undefined, false).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(GitHubApiError);
    expect((refused as GitHubApiError).code).toBe("rate-limited");
    expect(sends).toBe(1);
    const record = sqliteBudgetStore(path).read(githubCredential(ENV));
    expect(record?.limitedUntil ?? 0).toBeGreaterThan(currentMs() + 100_000);
  });

  it("keeps a cancellation after the request went out marked as sent, and one before it unsent", async () => {
    const path = databasePath();
    setForgeGovernor(
      budgetGovernor(sqliteBudgetStore(path), { share: () => null }),
    );
    const controller = new AbortController();
    const cut = (async (_url: unknown, init?: RequestInit) => {
      controller.abort(new Error("stop"));
      init?.signal?.throwIfAborted();
      return Response.json({ data: {} });
    }) as unknown as typeof fetch;
    const after = await httpTransport(
      "https://github.example/graphql",
      TOKEN,
      cut,
    )(QUERY, {}, controller.signal, false).then(
      () => null,
      (error: unknown) => error,
    );
    expect(after).toBeInstanceOf(GitHubApiError);
    expect((after as GitHubApiError).sent).toBe(true);

    const before = new AbortController();
    before.abort(new Error("never started"));
    const untouched = await httpTransport(
      "https://github.example/graphql",
      TOKEN,
      (() => {
        throw new Error("must not be sent");
      }) as unknown as typeof fetch,
    )(QUERY, {}, before.signal, false).then(
      () => null,
      (error: unknown) => error,
    );
    expect((untouched as GitHubApiError).sent).toBe(false);
  });
});
