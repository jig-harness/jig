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
});
