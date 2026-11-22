/**
 * The contract every transport to GitHub keeps, whatever carries its
 * requests: a status or a lost connection becomes the same failure class,
 * the rate-limit headers reach the credential's budget record, a
 * `304 Not Modified` answer is counted as not modified and charged nothing,
 * a list is read page by page through its `Link` header, and each attempt
 * is recorded with its operation and repository. `transportContract` runs
 * the cases against a transport a test builds over a fake GitHub.
 */
import { describe, expect, test } from "bun:test";
import type { BudgetStore } from "../outbound/budget-governor.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import type { CallRecord } from "../outbound/ledger.ts";
import { currentMs } from "../time.ts";

/** What the fake GitHub answers one request with: an HTTP answer, or no answer at all. */
export type Reply =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { network: true };

/** The fake GitHub: the answer to a request for `route` (the path after the host, its query included). */
export type Serve = (route: string) => Reply;

/** One read as a transport answered it. */
export interface Read {
  failure: OutboundFailure | null;
  /** The body, the held one for a `304`; `null` on a failure. */
  body: string | null;
  notModified: boolean;
}

/** A transport under test, built over a fake GitHub. */
export interface TransportUnderTest {
  /** The key its budget record and ledger rows are kept under. */
  credential: string;
  /** The budget store its governor keeps records in. */
  store: BudgetStore;
  /** Every attempt it recorded, in order. */
  records: CallRecord[];
  /** A REST read of `path`; with `held`, conditional on that body's validator. */
  get(path: string, held?: { etag: string; body: string }): Promise<Read>;
  /** Every page of the list at `path`, as one array of items. */
  pages(
    path: string,
  ): Promise<{ failure: OutboundFailure | null; items: unknown[] }>;
}

/** Builds a transport over `serve`. */
export type MakeTransport = (serve: Serve) => TransportUnderTest;

/** A fake answer's status line reason. */
export function reasonOf(status: number): string {
  const reasons: Record<number, string> = {
    200: "OK",
    304: "Not Modified",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
  };
  return reasons[status] ?? "Status";
}

const error = (message: string) => JSON.stringify({ message });

/** The rate-limit headers of a core answer with `remaining` of 5000 left until `reset` (epoch seconds). */
function limits(remaining: number, reset: number): Record<string, string> {
  return {
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
  };
}

const lastRecord = (t: TransportUnderTest) => t.records.at(-1);

/** Run the contract's cases against the transports `make` builds. */
export function transportContract(name: string, make: MakeTransport): void {
  describe(`${name} keeps the GitHub transport contract`, () => {
    const reset = Math.floor(currentMs() / 1000) + 3_600;

    test.each([
      [401, error("Bad credentials"), {}, "unauthorized"],
      [
        403,
        error("Resource not accessible by integration"),
        {},
        "unauthorized",
      ],
      [404, error("Not Found"), {}, "not-found"],
      [422, error("Validation Failed"), {}, "invalid"],
      [429, error("Too many requests"), {}, "rate-limited"],
      [500, error("Server Error"), {}, "server-fault"],
      [
        403,
        error("API rate limit exceeded for user ID 1."),
        limits(0, reset),
        "rate-limited",
      ],
    ] as const)(
      "HTTP %d reads as its failure class",
      async (status, body, headers, code) => {
        const t = make(() => ({ status, body, headers }));
        const read = await t.get("repos/o/r/pulls/1");
        expect(read.failure?.code).toBe(code);
        expect(lastRecord(t)).toMatchObject({ failure: code, requests: 1 });
      },
    );

    test("a spent primary limit holds until the reset its headers name", async () => {
      const t = make(() => ({
        status: 403,
        body: error("API rate limit exceeded for user ID 1."),
        headers: limits(0, reset),
      }));
      const read = await t.get("repos/o/r/pulls/1");
      expect(read.failure).toMatchObject({
        code: "rate-limited",
        until: reset * 1000,
      });
      expect(t.store.read(t.credential)?.requests).toMatchObject({
        remaining: 0,
        resetAt: reset * 1000,
      });
    });

    test("no answer at all is unreachable", async () => {
      const t = make(() => ({ network: true }));
      const read = await t.get("repos/o/r/pulls/1");
      expect(read.failure?.code).toBe("unreachable");
      expect(lastRecord(t)?.failure).toBe("unreachable");
    });

    test("the rate-limit headers reach the credential's budget record", async () => {
      const t = make(() => ({
        status: 200,
        body: "{}",
        headers: limits(4321, reset),
      }));
      const read = await t.get("repos/o/r/pulls/1");
      expect(read.failure).toBeNull();
      expect(t.store.read(t.credential)?.requests).toMatchObject({
        limit: 5000,
        remaining: 4321,
        resetAt: reset * 1000,
      });
    });

    test("a 304 answers with the held body, counted as not modified and charged nothing", async () => {
      const asked: string[] = [];
      const t = make((route) => {
        asked.push(route);
        return {
          status: 304,
          headers: { etag: '"one"', ...limits(4000, reset) },
        };
      });
      const read = await t.get("repos/o/r/pulls/1", {
        etag: '"one"',
        body: '{"held":true}',
      });
      expect(asked).toHaveLength(1);
      expect(read).toEqual({
        failure: null,
        body: '{"held":true}',
        notModified: true,
      });
      expect(lastRecord(t)).toMatchObject({
        requests: 1,
        notModified: 1,
        cost: 0,
        estimated: false,
        failure: null,
      });
      // No request was reserved: the balance is the one the answer reported.
      expect(t.store.read(t.credential)?.requests.remaining).toBe(4000);
    });

    test("a conditional read that changed is charged one request", async () => {
      const t = make(() => ({
        status: 200,
        body: '{"fresh":true}',
        headers: { etag: '"two"', ...limits(3999, reset) },
      }));
      const read = await t.get("repos/o/r/pulls/1", {
        etag: '"one"',
        body: "{}",
      });
      expect(read).toEqual({
        failure: null,
        body: '{"fresh":true}',
        notModified: false,
      });
      expect(lastRecord(t)).toMatchObject({
        requests: 1,
        notModified: 0,
        cost: 1,
        failure: null,
      });
    });

    test("each attempt is recorded with its operation and repository", async () => {
      const t = make(() => ({
        status: 200,
        body: "{}",
        headers: limits(10, reset),
      }));
      await t.get("repos/Owner/Repo/pulls/7");
      expect(lastRecord(t)).toMatchObject({
        system: "github",
        credential: t.credential,
        operation: "GET /repos/{}/{}/pulls/{}",
        repository: "owner/repo",
        unit: "requests",
        window: "requests",
      });
    });

    test("a list is read page by page through its Link header", async () => {
      const asked: string[] = [];
      const t = make((route) => {
        asked.push(route);
        const page = new URLSearchParams(route.split("?")[1] ?? "").get("page");
        return page === "2"
          ? { status: 200, body: "[3]", headers: limits(98, reset) }
          : {
              status: 200,
              body: "[1,2]",
              headers: {
                link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
                ...limits(99, reset),
              },
            };
      });
      const read = await t.pages("repos/o/r/issues");
      expect(read).toEqual({ failure: null, items: [1, 2, 3] });
      expect(asked).toHaveLength(2);
      expect(t.records.map((r) => r.requests)).toEqual([1, 1]);
      expect(t.store.read(t.credential)?.requests.remaining).toBe(98);
    });
  });
}
