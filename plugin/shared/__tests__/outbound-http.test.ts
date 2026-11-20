/**
 * The governed HTTP transport for systems that report no rate limit
 * (`outbound/http.ts`): one request within its deadline, its failure as one
 * of the closed classes, one ledger row for each request that left, and the
 * address, a credential, never in a reason or a row.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { httpAddress, sendHttp, type HttpRequest } from "../outbound/http.ts";

const SECRET = "s3cr3t-token-path";
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(answer: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/hooks/${SECRET}`;
}

async function send(
  url: string,
  extra: Partial<HttpRequest> = {},
): Promise<{
  outcome: Awaited<ReturnType<typeof sendHttp>>;
  rows: CallRecord[];
}> {
  const rows: CallRecord[] = [];
  const outcome = await withLedgerWriter(
    (row) => rows.push(row),
    () =>
      sendHttp({
        system: "webhook",
        operation: "WebhookPost text",
        url,
        destination: "the phone webhook",
        body: "hello",
        timeoutMs: 2000,
        ...extra,
      }),
  );
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  expect(JSON.stringify(rows)).not.toContain(SECRET);
  return { outcome, rows };
}

describe("an answer", () => {
  it("of 2xx succeeds, with one request in the ledger under a hash of the address", async () => {
    let body = "";
    const url = serve(async (r) => {
      body = await r.text();
      return new Response(null, { status: 204 });
    });
    const { outcome, rows } = await send(url);
    expect(outcome).toMatchObject({ ok: true, value: { status: 204 } });
    expect(body).toBe("hello");
    expect(rows).toEqual([
      expect.objectContaining({
        system: "webhook",
        operation: "WebhookPost text",
        credential: expect.stringMatching(/^webhook:[0-9a-f]{16}$/),
        cost: 1,
        unit: "requests",
        failure: null,
      }),
    ]);
  });

  for (const [status, code] of [
    [500, "server-fault"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [400, "invalid"],
    [302, "invalid"],
  ] as const)
    it(`of HTTP ${status} is ${code}`, async () => {
      const url = serve(
        () =>
          new Response(`the hook ${SECRET} is gone`, {
            status,
            headers:
              status === 302 ? { location: "https://example.test/" } : {},
          }),
      );
      const { outcome, rows } = await send(url);
      expect(outcome).toMatchObject({
        ok: false,
        failure: { code, reason: expect.stringContaining("the phone webhook") },
      });
      expect(rows.map((r) => r.failure)).toEqual([code]);
    });

  it("of 429 is rate-limited until its Retry-After", async () => {
    const url = serve(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    const before = Date.now();
    const { outcome } = await send(url);
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "rate-limited", retryAfterMs: 30_000 },
    });
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.failure.until).toBeGreaterThanOrEqual(before + 30_000);
  });
});

describe("no answer", () => {
  it("from a closed port is unreachable, the platform's message withheld", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    const url = `http://127.0.0.1:${server.port}/hooks/${SECRET}`;
    server.stop(true);
    const { outcome, rows } = await send(url);
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "unreachable" },
    });
    expect(rows.map((r) => r.failure)).toEqual(["unreachable"]);
  });

  it("from a fetch that throws with the address in its message keeps the address out", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      throw new Error(`could not reach ${String(input)}`);
    }) as unknown as typeof fetch;
    const { outcome } = await send(`https://hooks.example.test/${SECRET}`, {
      fetchImpl,
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "unreachable",
        reason: "the phone webhook could not be reached (Error)",
      },
    });
  });

  it("within the deadline is unreachable and marked sent", async () => {
    const url = serve(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response()), 5000),
        ),
    );
    const { outcome, rows } = await send(url, { timeoutMs: 50 });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "unreachable",
        sent: true,
        reason: expect.stringContaining("within 50ms"),
      },
    });
    expect(rows).toHaveLength(1);
  });

  it("before the caller's signal aborts is unreachable and marked sent", async () => {
    const url = serve(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response()), 5000),
        ),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { outcome } = await send(url, { signal: controller.signal });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "unreachable",
        sent: true,
        reason: expect.stringContaining("stopped"),
      },
    });
  });
});

describe("a request that never leaves", () => {
  it("is not sent once its signal has aborted, and costs nothing", async () => {
    let hits = 0;
    const url = serve(() => {
      hits++;
      return new Response();
    });
    const controller = new AbortController();
    controller.abort();
    const { outcome, rows } = await send(url, { signal: controller.signal });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "unreachable" },
    });
    expect(hits).toBe(0);
    expect(rows).toEqual([]);
  });

  it("is not sent to an address other than https: or the loopback host", async () => {
    for (const url of [
      `http://hooks.example.test/${SECRET}`,
      `ftp://127.0.0.1/${SECRET}`,
      `not an address ${SECRET}`,
    ]) {
      const { outcome, rows } = await send(url);
      expect(outcome).toMatchObject({
        ok: false,
        failure: { code: "invalid" },
      });
      expect(rows).toEqual([]);
    }
    expect(httpAddress("https://ntfy.example.test/topic").ok).toBe(true);
    expect(httpAddress("http://localhost:8080/topic").ok).toBe(true);
    expect(httpAddress("http://[::1]:8080/topic").ok).toBe(true);
  });
});
