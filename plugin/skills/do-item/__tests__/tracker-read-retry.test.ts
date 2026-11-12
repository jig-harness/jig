import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { gitHubClient } from "../scripts/lib/tracker/github/client.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { gitHubTracker } from "../scripts/lib/tracker/github/tracker.ts";
import {
  httpTransport as jiraHttp,
  searchPages,
} from "../scripts/lib/tracker/jira/transport.ts";
import { jiraAuthorization } from "../scripts/lib/tracker/jira/credential.ts";
import { retryRead, waitForRetry } from "../scripts/lib/tracker/read-retry.ts";
import {
  TrackerRateLimited,
  type BudgetGovernor,
  budgetGovernor,
  memoryBudgetStore,
} from "../../../shared/tracker-budget.ts";
import {
  ghTransport,
  httpTransport as githubHttp,
} from "../scripts/lib/tracker/github/transport.ts";

const auth = () => jiraAuthorization({ kind: "bearer", token: "test" });
function responses(status: number, succeeds = true) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(
      JSON.stringify(
        calls > 1 && succeeds
          ? { data: { ok: true }, issues: [], isLast: true }
          : {},
      ),
      {
        status: calls > 1 && succeeds ? 200 : status,
        headers: { "Retry-After": "0" },
      },
    );
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("tracker read retries", () => {
  it("retries a Jira GET after 429", async () => {
    const f = responses(429);
    await jiraHttp(
      "https://jira.example",
      auth(),
      f.fetcher,
    )({ method: "GET", path: "myself" });
    expect(f.calls()).toBe(2);
  });
  it("retries the Jira read-only POST search", async () => {
    const f = responses(429);
    expect(
      await searchPages(
        jiraHttp("https://jira.example", auth(), f.fetcher),
        "project = ENG",
        [],
        "test",
      ),
    ).toEqual([]);
    expect(f.calls()).toBe(2);
  });
  it("stops after three retries on 503", async () => {
    const f = responses(503, false);
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
      )({ method: "GET", path: "myself" }),
    ).rejects.toThrow("503");
    expect(f.calls()).toBe(4);
  });
  it("never retries a Jira write", async () => {
    const f = responses(429);
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
      )({ method: "POST", path: "issue" }),
    ).rejects.toThrow("429");
    expect(f.calls()).toBe(1);
  });
  it("retries an explicitly read-only GraphQL query", async () => {
    const f = responses(429);
    expect(
      await githubHttp("https://github.example/graphql", "test", f.fetcher)(
        "query { viewer { login } }",
        {},
        undefined,
        true,
      ),
    ).toEqual({ ok: true });
    expect(f.calls()).toBe(2);
  });
  it("never retries a GraphQL mutation", async () => {
    const f = responses(503);
    await expect(
      githubHttp(
        "https://github.example/graphql",
        "test",
        f.fetcher,
      )("mutation { write }", {}),
    ).rejects.toThrow("503");
    expect(f.calls()).toBe(1);
  });
  it("aborts a retry wait before another request leaves", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      queueMicrotask(() => controller.abort(new Error("cancelled test")));
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    }) as unknown as typeof fetch;
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        fetcher,
      )({ method: "GET", path: "myself" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });
});

describe("read retry bounds", () => {
  it("caps each wait and honors an HTTP-date Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryRead(
      async () => ({
        status: ++calls < 3 ? 503 : 200,
        headers: new Headers({
          "Retry-After": calls === 1 ? "120" : "Thu, 01 Jan 1970 00:00:05 GMT",
        }),
      }),
      true,
      new AbortController().signal,
      async (ms) => {
        waits.push(ms);
      },
      () => 1000,
    );
    expect(waits).toEqual([30000, 4000]);
  });
  it("ends at the original deadline during a wait", async () => {
    let calls = 0;
    await expect(
      retryRead(
        async () => {
          calls++;
          return { status: 503, headers: new Headers({ "Retry-After": "30" }) };
        },
        true,
        AbortSignal.timeout(10),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("cancels after the wait starts", async () => {
    const controller = new AbortController();
    const waiting = waitForRetry(30000, controller.signal);
    controller.abort(new Error("wait cancelled"));
    await expect(waiting).rejects.toThrow("wait cancelled");
  });
  it("preserves a Jira governor hold before retrying", async () => {
    const f = responses(429);
    let limited = false;
    const governor: BudgetGovernor = {
      admit() {
        if (limited) throw new TrackerRateLimited("jira", 1000, "held");
      },
      observe() {
        limited = true;
      },
    };
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
        governor,
      )({ method: "GET", path: "myself" }),
    ).rejects.toBeInstanceOf(TrackerRateLimited);
    expect(f.calls()).toBe(1);
    expect(limited).toBe(true);
  });
});

describe("GitHub command-line retries", () => {
  for (const read of [true, false]) {
    it(`retries a throttled query only when marked read-only: ${read}`, async () => {
      let calls = 0;
      const transport = ghTransport(async (argv) => {
        expect(argv).toContain("--include");
        const refused = ++calls === 1;
        return {
          code: refused ? 1 : 0,
          stdout: `HTTP/2.0 ${refused ? "429 Too Many Requests" : "200 OK"}\nRetry-After: 0\r\n\r\n${JSON.stringify(refused ? {} : { data: { ok: true } })}`,
          stderr: refused ? "HTTP 429" : "",
          stderrTail: "",
          timedOut: false,
          bufferExceeded: false,
          spawnFailed: false,
        };
      });
      const result = transport(
        "query { viewer { login } }",
        {},
        undefined,
        read,
      );
      if (read) expect(await result).toEqual({ ok: true });
      else await expect(result).rejects.toThrow("429");
      expect(calls).toBe(read ? 2 : 1);
    });
  }
});

it("uses the same HTTP-date reset for Jira retries and the credential governor", async () => {
  let calls = 0;
  const fetcher = (async () =>
    new Response("{}", {
      status: ++calls === 1 ? 429 : 200,
      headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT" },
    })) as unknown as typeof fetch;
  const governor = budgetGovernor(memoryBudgetStore());
  await jiraHttp(
    "https://jira.example",
    auth(),
    fetcher,
    governor,
  )({ method: "GET", path: "myself" });
  expect(calls).toBe(2);
});

it("marks client reads and keeps both mutation entry points unmarked", async () => {
  const config = parseTrackerConfig({ issue_tracker: { adapter: "github" } });
  const marked: boolean[] = [];
  const client = gitHubClient({
    home: { owner: "acme", name: "app" },
    model: gitHubModel(config.states, config.github),
    settings: config.github,
    transport: async (_query, _variables, _signal, idempotent = false) => {
      marked.push(idempotent);
      return { repository: { id: "R_1" } };
    },
  });
  await client.repositoryId();
  await client.mutate("mutation { write }", {});
  await gitHubTracker(client).postComment("I_test", "comment");
  expect(marked).toEqual([true, false, false]);
});

it("reports a long credential hold immediately instead of losing it at the deadline", async () => {
  const fetcher = (async () =>
    new Response("{}", {
      status: 429,
      headers: { "Retry-After": "1e13" },
    })) as unknown as typeof fetch;
  await expect(
    jiraHttp(
      "https://jira.example",
      auth(),
      fetcher,
      budgetGovernor(memoryBudgetStore()),
    )({ method: "GET", path: "myself" }, AbortSignal.timeout(20)),
  ).rejects.toBeInstanceOf(TrackerRateLimited);
});

it("retries after a short credential hold has expired", async () => {
  let calls = 0;
  const fetcher = (async () =>
    new Response("{}", {
      status: ++calls === 1 ? 429 : 200,
      headers: { "Retry-After": "0.001" },
    })) as unknown as typeof fetch;
  await jiraHttp(
    "https://jira.example",
    auth(),
    fetcher,
    budgetGovernor(memoryBudgetStore()),
  )({ method: "GET", path: "myself" });
  expect(calls).toBe(2);
});

it("preserves explicit caller cancellation over a credential hold", async () => {
  const controller = new AbortController();
  const fetcher = (async () => {
    controller.abort(new Error("caller cancelled"));
    return new Response("{}", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
  }) as unknown as typeof fetch;
  await expect(
    jiraHttp(
      "https://jira.example",
      auth(),
      fetcher,
      budgetGovernor(memoryBudgetStore()),
    )({ method: "GET", path: "myself" }, controller.signal),
  ).rejects.toThrow("caller cancelled");
});

it("keeps the known credential refusal when response cleanup fails", async () => {
  const fetcher = (async () =>
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
      { status: 429, headers: { "Retry-After": "30" } },
    )) as unknown as typeof fetch;
  await expect(
    jiraHttp(
      "https://jira.example",
      auth(),
      fetcher,
      budgetGovernor(memoryBudgetStore()),
    )({ method: "GET", path: "myself" }),
  ).rejects.toBeInstanceOf(TrackerRateLimited);
});

it("retries a refused read even when response cleanup fails", async () => {
  let calls = 0;
  const fetcher = (async () => {
    if (++calls > 1) return new Response("{}");
    return new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
      { status: 429, headers: { "Retry-After": "0" } },
    );
  }) as unknown as typeof fetch;
  expect(
    await jiraHttp(
      "https://jira.example",
      auth(),
      fetcher,
    )({ method: "GET", path: "myself" }),
  ).toEqual({});
  expect(calls).toBe(2);
});
