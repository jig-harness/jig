/**
 * The tracker transports' one retry (`shared/outbound/retry.ts`): a read
 * that met `unreachable` or `server-fault` is sent once more inside the
 * call's deadline; a write, a rate limit and every other failure are sent
 * once.
 */
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
import { httpTransport as linearHttp } from "../scripts/lib/tracker/linear-transport.ts";
import {
  TrackerRateLimited,
  type BudgetGovernor,
  budgetGovernor,
  memoryBudgetStore,
} from "../../../shared/outbound/budget.ts";
import {
  ghTransport,
  httpTransport as githubHttp,
} from "../scripts/lib/tracker/github/transport.ts";

const auth = () => jiraAuthorization({ kind: "bearer", token: "test" });

/** A fetch that answers `status` until `succeedAfter` requests, then 200. */
function responses(status: number, succeedAfter = 1) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    const ok = calls > succeedAfter;
    return new Response(
      JSON.stringify(
        ok ? { data: { ok: true }, issues: [], isLast: true } : {},
      ),
      { status: ok ? 200 : status, headers: { "Retry-After": "0" } },
    );
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("tracker read retries", () => {
  it("sends a Jira GET once more after a 503", async () => {
    const f = responses(503);
    await jiraHttp(
      "https://jira.example",
      auth(),
      f.fetcher,
    )({ method: "GET", path: "myself" });
    expect(f.calls()).toBe(2);
  });

  it("sends the Jira read-only POST search once more after a 503", async () => {
    const f = responses(503);
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

  it("stops after one retry on 503", async () => {
    const f = responses(503, 10);
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
      )({ method: "GET", path: "myself" }),
    ).rejects.toMatchObject({ code: "server-fault" });
    expect(f.calls()).toBe(2);
  });

  it("does not send a read again after a 429: it fails rate-limited until the reset", async () => {
    const f = responses(429);
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
      )({ method: "GET", path: "myself" }),
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(f.calls()).toBe(1);
  });

  it("never retries a Jira write", async () => {
    const f = responses(503);
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        f.fetcher,
      )({ method: "POST", path: "issue" }),
    ).rejects.toThrow("503");
    expect(f.calls()).toBe(1);
  });

  it("sends an explicitly read-only GraphQL query once more", async () => {
    const f = responses(503);
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

  it("sends a Linear query once more, and a Linear mutation once", async () => {
    const read = responses(503);
    expect(
      await linearHttp("lin_test", read.fetcher)(
        "query Q { viewer { id } }",
        {},
      ),
    ).toEqual({ ok: true });
    expect(read.calls()).toBe(2);
    const write = responses(503);
    await expect(
      linearHttp("lin_test", write.fetcher)("mutation M { write }", {}),
    ).rejects.toMatchObject({ code: "server-fault" });
    expect(write.calls()).toBe(1);
  });

  it("aborts a retry wait before another request leaves", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      queueMicrotask(() => controller.abort(new Error("cancelled test")));
      return new Response("{}", {
        status: 503,
        headers: { "Retry-After": "20" },
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

  it("preserves a Jira governor hold: a refused credential sends nothing more", async () => {
    const f = responses(429);
    let limited = false;
    const governor: BudgetGovernor = {
      admit() {
        if (limited) throw new TrackerRateLimited("jira", 1000, "held");
        return 0;
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
    it(`sends a query once more after a server fault only when marked read-only: ${read}`, async () => {
      let calls = 0;
      const transport = ghTransport(async (argv) => {
        expect(argv).toContain("--include");
        const refused = ++calls === 1;
        return {
          code: refused ? 1 : 0,
          stdout: `HTTP/2.0 ${refused ? "503 Service Unavailable" : "200 OK"}\nRetry-After: 0\r\n\r\n${JSON.stringify(refused ? {} : { data: { ok: true } })}`,
          stderr: refused ? "HTTP 503" : "",
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
      else await expect(result).rejects.toThrow("503");
      expect(calls).toBe(read ? 2 : 1);
    });
  }
});

it("parses GitHub CLI's mixed-newline headerless response", async () => {
  const transport = ghTransport(async () => ({
    code: 0,
    stdout: 'HTTP/2.0 200 OK\n\r\n{"data":{"ok":true}}',
    stderr: "",
    stderrTail: "",
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
  }));
  await expect(transport("query { ok }", {})).resolves.toEqual({ ok: true });
});

for (const body of ['{"errors":[{"message":"down"}]}', "<html>down</html>"]) {
  it(`keeps a failed gh response's class and wait: ${body}`, async () => {
    const transport = ghTransport(async () => ({
      code: 1,
      stdout: `HTTP/2.0 503 Service Unavailable\r\nRetry-After: 7\r\n\r\n${body}`,
      stderr: "",
      stderrTail: "",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
    }));
    await expect(
      transport("query { viewer { login } }", {}),
    ).rejects.toMatchObject({
      code: "server-fault",
      unavailable: true,
      retryAfterSec: 7,
    });
  });
}

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

it("reports a credential hold without waiting for stream cleanup", async () => {
  let cancelled = false;
  const fetcher = (async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {
            // The stream never settles its cancellation callback.
          });
        },
      }),
      { status: 429, headers: { "Retry-After": "1e13" } },
    )) as unknown as typeof fetch;
  const pending = jiraHttp(
    "https://jira.example",
    auth(),
    fetcher,
    budgetGovernor(memoryBudgetStore()),
  )({ method: "GET", path: "myself" });
  await expect(
    Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("credential refusal remained pending")),
          100,
        ),
      ),
    ]),
  ).rejects.toBeInstanceOf(TrackerRateLimited);
  expect(cancelled).toBe(true);
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

it("sends a read again after a server fault even when response cleanup fails", async () => {
  let calls = 0;
  const fetcher = (async () => {
    if (++calls > 1) return new Response("{}");
    return new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
      { status: 503, headers: { "Retry-After": "0" } },
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

describe("a decoded answer and a cancelled write keep what happened", () => {
  it("sends a Jira read once more after a 200 whose body is not JSON", async () => {
    let calls = 0;
    const fetcher = (async () =>
      ++calls > 1
        ? new Response("{}", { status: 200, headers: { "Retry-After": "0" } })
        : new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(
      await jiraHttp(
        "https://jira.example",
        auth(),
        fetcher,
      )({ method: "GET", path: "myself" }),
    ).toEqual({});
    expect(calls).toBe(2);
  });

  it("marks a Jira write cancelled after its request left as possibly landed", async () => {
    const controller = new AbortController();
    const fetcher = (async () => {
      queueMicrotask(() => controller.abort(new Error("cancelled test")));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      jiraHttp(
        "https://jira.example",
        auth(),
        fetcher,
      )({ method: "POST", path: "issue" }, controller.signal),
    ).rejects.toMatchObject({ sent: true });
  });

  it("marks a Linear mutation cancelled after its request left as possibly landed", async () => {
    const controller = new AbortController();
    const fetcher = (async () => {
      queueMicrotask(() => controller.abort(new Error("cancelled test")));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      linearHttp("token", fetcher)("mutation { x }", {}, controller.signal),
    ).rejects.toMatchObject({ sent: true });
  });
});
