import { describe, expect, test } from "bun:test";
import {
  budgetGovernorWith,
  memoryBudgetStore,
} from "../outbound/budget-governor.ts";
import { validatorCache } from "../outbound/cache.ts";
import {
  type GitHubFetchOptions,
  githubFetchTransport,
} from "../outbound/github-fetch.ts";
import type { CallRecord } from "../outbound/ledger.ts";
import { currentMs } from "../time.ts";
import {
  type Serve,
  type TransportUnderTest,
  transportContract,
} from "./outbound-transport-contract.ts";

const BASE = "https://api.github.com";
const CREDENTIAL = "github:fetch-contract";

/** A fake `fetch` over `serve`, which honours the request's signal. */
function fakeFetch(serve: Serve, asked: RequestInit[] = []) {
  return (url: string, init: RequestInit): Promise<Response> => {
    asked.push(init);
    init.signal?.throwIfAborted();
    const reply = serve(url.slice(BASE.length + 1));
    if ("network" in reply)
      return Promise.reject(new TypeError("fetch failed"));
    const empty = reply.status === 304 || reply.status === 204;
    return Promise.resolve(
      new Response(empty ? null : (reply.body ?? ""), {
        status: reply.status,
        headers: reply.headers ?? {},
      }),
    );
  };
}

/** A transport over `serve` with an in-memory budget, held bodies and ledger. */
function build(serve: Serve, extra: Partial<GitHubFetchOptions> = {}) {
  const store = memoryBudgetStore();
  const records: CallRecord[] = [];
  const kept = new Map<string, unknown>();
  const held = validatorCache({
    get: (key) => kept.get(key),
    set: (key, value) => kept.set(key, value),
  });
  const transport = githubFetchTransport({
    fetch: fakeFetch(serve),
    token: () => "fetch-contract-token",
    credential: CREDENTIAL,
    record: (call) => records.push(call),
    governor: budgetGovernorWith(store),
    held,
    wait: () => Promise.resolve(),
    ...extra,
  });
  return { store, records, held, transport };
}

const call = () => ({
  signal: new AbortController().signal,
  deadlineAt: currentMs() + 10_000,
});

transportContract("the fetch transport", (serve): TransportUnderTest => {
  const { store, records, held, transport } = build(serve);
  return {
    credential: CREDENTIAL,
    store,
    records,
    async get(path, kept) {
      if (kept !== undefined)
        held.set(CREDENTIAL, `${BASE}/${path}`, kept.etag, kept.body);
      const read = await transport.rest({
        ...call(),
        path,
        conditional: kept !== undefined,
      });
      return read.ok
        ? {
            failure: null,
            body: read.value.body,
            notModified: read.value.notModified,
          }
        : { failure: read.failure, body: null, notModified: false };
    },
    async pages(path) {
      const read = await transport.pages({ ...call(), path });
      return read.ok
        ? { failure: null, items: read.value }
        : { failure: read.failure, items: [] };
    },
  };
});

describe("the fetch transport, beyond the shared contract", () => {
  test("a read the system answered at fault is sent once more; a write never", async () => {
    const read = build(() => ({ status: 500, body: "{}" }));
    const got = await read.transport.rest({ ...call(), path: "repos/o/r" });
    expect(got.ok ? null : got.failure.code).toBe("server-fault");
    expect(read.records).toHaveLength(2);
    const write = build(() => ({ status: 500, body: "{}" }));
    const posted = await write.transport.rest({
      ...call(),
      method: "POST",
      path: "repos/o/r/issues",
      body: { title: "t" },
    });
    expect(posted.ok ? null : posted.failure.code).toBe("server-fault");
    expect(write.records).toHaveLength(1);
  });

  test("a deadline that passes with no answer is unreachable, and a lost write says it may have landed", async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    const { transport, records } = build(() => ({ status: 200 }), {
      fetch: hanging,
    });
    const got = await transport.rest({
      signal: new AbortController().signal,
      deadlineAt: currentMs() + 50,
      method: "PATCH",
      path: "repos/o/r/issues/1",
      body: {},
    });
    expect(got.ok ? null : got.failure).toMatchObject({
      code: "unreachable",
      sent: true,
    });
    expect(records.at(-1)).toMatchObject({
      requests: 1,
      failure: "unreachable",
    });
  });

  test("a cancelled call sends nothing", async () => {
    const asked: RequestInit[] = [];
    const { transport, records } = build(() => ({ status: 200 }), {
      fetch: fakeFetch(() => ({ status: 200, body: "{}" }), asked),
    });
    const controller = new AbortController();
    controller.abort();
    const got = await transport.rest({
      signal: controller.signal,
      deadlineAt: currentMs() + 10_000,
      path: "repos/o/r",
    });
    expect(got.ok ? null : got.failure.code).toBe("unreachable");
    expect(asked).toHaveLength(0);
    expect(records.every((r) => r.requests === 0)).toBe(true);
  });

  test("a credential the budget holds sends nothing and fails as rate-limited", async () => {
    const asked: RequestInit[] = [];
    const { transport, records, store } = build(() => ({ status: 200 }), {
      fetch: fakeFetch(() => ({ status: 200, body: "{}" }), asked),
    });
    const until = currentMs() + 600_000;
    store.update(CREDENTIAL, () => ({
      requests: { limit: 5000, remaining: 5000, resetAt: until },
      complexity: { limit: 5000, remaining: 5000, resetAt: until },
      limitedUntil: until,
      why: "refused",
      observedAt: currentMs(),
    }));
    const got = await transport.rest({ ...call(), path: "repos/o/r" });
    expect(got.ok ? null : got.failure).toMatchObject({
      code: "rate-limited",
      until,
    });
    expect(asked).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({
      requests: 0,
      failure: "rate-limited",
    });
  });

  test("no token fails as unauthorized and sends nothing", async () => {
    const asked: RequestInit[] = [];
    const { transport } = build(() => ({ status: 200 }), {
      fetch: fakeFetch(() => ({ status: 200, body: "{}" }), asked),
      token: () => null,
    });
    const got = await transport.rest({ ...call(), path: "repos/o/r" });
    expect(got.ok ? null : got.failure.code).toBe("unauthorized");
    expect(asked).toHaveLength(0);
  });

  test("a GraphQL query records the points its answer reports, and its errors fail as their class", async () => {
    const { transport, records } = build(() => ({
      status: 200,
      body: JSON.stringify({
        data: {
          rateLimit: {
            cost: 3,
            remaining: 4990,
            limit: 5000,
            resetAt: "2099-01-01T00:00:00Z",
          },
        },
      }),
    }));
    const got = await transport.graphql({
      ...call(),
      query: "query Pulls { rateLimit { cost } }",
      repository: "o/r",
    });
    expect(got.ok).toBe(true);
    expect(records.at(-1)).toMatchObject({
      operation: "Pulls",
      unit: "points",
      cost: 3,
      estimated: false,
      repository: "o/r",
    });
    const missing = build(() => ({
      status: 200,
      body: JSON.stringify({
        errors: [{ type: "NOT_FOUND", message: "gone" }],
      }),
    }));
    const lost = await missing.transport.graphql({
      ...call(),
      query: 'query { repository(owner: "o", name: "r") { id } }',
    });
    expect(lost.ok ? null : lost.failure.code).toBe("not-found");
  });

  test("an Enterprise Server's API is asked at its own host, and a next link off it is not followed", async () => {
    const urls: string[] = [];
    const { transport } = build(() => ({ status: 200 }), {
      baseUrl: "https://ghe.example/api/v3",
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(
          new Response("[1]", {
            status: 200,
            headers: {
              link: '<https://elsewhere.example/x?page=2>; rel="next"',
            },
          }),
        );
      },
    });
    const got = await transport.pages({ ...call(), path: "repos/o/r/issues" });
    expect(got).toEqual({ ok: true, value: [1] });
    expect(urls).toEqual(["https://ghe.example/api/v3/repos/o/r/issues"]);
  });
});
