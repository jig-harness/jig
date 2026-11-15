import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  type BudgetRecord,
  budgetGovernor,
  memoryBudgetStore,
} from "../outbound/budget.ts";
import { endCursorOf, PAGE_CAP, pagePlan } from "../outbound/gh-paginate.ts";
import {
  githubCredential,
  PAGINATED_RESERVE,
  setForgeGovernor,
} from "../outbound/github-budget.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { ghRunFailure } from "../outbound/github.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { currentMs } from "../time.ts";
import { traceGhRunner } from "../trace.ts";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  held?: OutboundFailure;
}
interface Opts {
  env?: Record<string, string>;
  timeoutSec?: number;
  stdout?: "pipe" | "inherit" | "ignore";
}

const ENV = { GH_TOKEN: "test-paged-token" };
const KEY = githubCredential(ENV);
const RESET = 2_000_000;
const API = "https://api.github.com/repos/o/r/items";

afterEach(() => {
  setForgeGovernor(null);
  setSystemTime();
});

/** A record whose core window holds `remaining` of 5000, under a dispatcher's `share`. */
function budget(remaining: number, share: number | null = null) {
  const store = memoryBudgetStore();
  setForgeGovernor(
    budgetGovernor(store, { clock: () => 1_000_000, share: () => share }),
  );
  const record: BudgetRecord = {
    requests: { limit: 5000, remaining, resetAt: RESET },
    complexity: { limit: 5000, remaining: 5000, resetAt: RESET },
    limitedUntil: null,
    why: null,
    observedAt: 1_000_000,
  };
  store.update(KEY, () => record);
  return {
    requests: () => store.read(KEY)?.requests.remaining,
    complexity: () => store.read(KEY)?.complexity.remaining,
  };
}

interface Sent {
  argv: string[];
  timeoutSec: number | undefined;
}

/** A forge client whose `gh` is `answer`, with the ledger rows it wrote. */
function client(answer: (argv: string[], n: number) => Run | Promise<Run>) {
  const sent: Sent[] = [];
  const runner = traceGhRunner<Run, Opts>(
    async (argv, opts) => {
      sent.push({ argv, timeoutSec: opts.timeoutSec });
      return answer(argv, sent.length);
    },
    () => 30,
    { env: ENV },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: `${failure.reason}\n`,
      timedOut: false,
      held: failure,
    }),
  );
  const rows: CallRecord[] = [];
  return {
    sent,
    rows,
    run: (args: string[], opts: Opts = {}) =>
      withLedgerWriter(
        (row) => rows.push(row),
        () => runner(args, { env: ENV, ...opts }),
      ),
  };
}

/** The page a REST route asks for: 1 for the caller's own route. */
function pageOf(argv: string[]): number {
  const url = argv.find((a) => a.startsWith(API));
  return url === undefined ? 1 : Number(new URL(url).searchParams.get("page"));
}

/** `pages` pages of two items each, each naming the next. */
function restPages(pages: number) {
  return (argv: string[]): Run => {
    const page = pageOf(argv);
    const link =
      page < pages
        ? `Link: <${API}?per_page=2&page=${page + 1}>; rel="next", <${API}?page=${pages}>; rel="last"\n`
        : "";
    const items = [`a${page}`, `b${page}`];
    const body = argv.includes("--jq")
      ? items.map((i) => `${i}\n`).join("")
      : JSON.stringify(items.map((name) => ({ name })));
    return {
      code: 0,
      stdout: `HTTP/2.0 200 OK\n${link}X-Ratelimit-Resource: core\n\n${body}`,
      stderr: "",
      timedOut: false,
    };
  };
}

describe("a paged REST read the forge client sends a page at a time", () => {
  it("charges each page it sent to the record and the ledger, and merges the pages' arrays as gh does", async () => {
    const record = budget(1000);
    const forge = client(restPages(3));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual(
      ["a1", "b1", "a2", "b2", "a3", "b3"].map((name) => ({ name })),
    );
    expect(read.stdout).not.toContain("HTTP/");
    expect(forge.sent.map((s) => s.argv)).toEqual([
      ["api", "repos/o/r/items", "--include"],
      ["api", `${API}?per_page=2&page=2`, "--include"],
      ["api", `${API}?per_page=2&page=3`, "--include"],
    ]);
    expect(record.requests()).toBe(997);
    expect(forge.rows.map((r) => r.requests)).toEqual([1, 1, 1]);
    expect(forge.rows.map((r) => r.window)).toEqual([
      "requests",
      "requests",
      "requests",
    ]);
  });

  it("wraps the pages in one array for --slurp and keeps the caller's flags on every page", async () => {
    budget(1000);
    const forge = client(restPages(2));
    const read = await forge.run([
      "api",
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
      "repos/o/r/items",
    ]);
    expect(JSON.parse(read.stdout)).toEqual([
      [{ name: "a1" }, { name: "b1" }],
      [{ name: "a2" }, { name: "b2" }],
    ]);
    expect(forge.sent[1]?.argv).toEqual([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `${API}?per_page=2&page=2`,
      "--include",
    ]);
  });

  it("joins each page's --jq output in turn, and sends a GET's fields with the first page only", async () => {
    budget(1000);
    const forge = client(restPages(2));
    const read = await forge.run([
      "api",
      "--paginate",
      "--method",
      "GET",
      "-f",
      "per_page=2",
      "repos/o/r/items",
      "--jq",
      ".[].name",
    ]);
    expect(read.stdout).toBe("a1\nb1\na2\nb2\n");
    expect(forge.sent[0]?.argv).toContain("per_page=2");
    expect(forge.sent[1]?.argv).toEqual([
      "api",
      "--method",
      "GET",
      `${API}?per_page=2&page=2`,
      "--jq",
      ".[].name",
      "--include",
    ]);
  });

  it("stops at the dispatcher's floor: the page it refuses is not sent, and the pages before it stay charged", async () => {
    // Half of 5000 is kept for passes and people: 2502 admits two pages.
    const record = budget(2502, 0.5);
    const forge = client(restPages(5));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(2);
    expect(read.code).not.toBe(0);
    expect(ghRunFailure(read)).toMatchObject({
      code: "rate-limited",
      until: RESET,
    });
    expect(record.requests()).toBe(2500);
    expect(forge.rows.map((r) => r.requests)).toEqual([1, 1, 0]);
  });

  it("ends at a page that fails, keeping what the pages before it said and sending no more", async () => {
    const record = budget(1000);
    const pages = restPages(4);
    const forge = client((argv, n) =>
      n === 2
        ? {
            code: 1,
            stdout: 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}',
            stderr: "gh: Not Found (HTTP 404)\n",
            timedOut: false,
          }
        : pages(argv),
    );
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(2);
    expect(read.code).toBe(1);
    expect(ghRunFailure(read)?.code).toBe("not-found");
    expect(JSON.parse(read.stdout)).toEqual([{ name: "a1" }, { name: "b1" }]);
    expect(record.requests()).toBe(998);
  });

  it("answers a failing first page as a single call does", async () => {
    budget(1000);
    const forge = client(() => ({
      code: 1,
      stdout: 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}',
      stderr: "gh: Not Found (HTTP 404)\n",
      timedOut: false,
    }));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(read.stdout).toBe('{"message":"Not Found"}');
    expect(forge.sent).toHaveLength(1);
  });

  it("charges each page every time a retry sends it again", async () => {
    const record = budget(1000);
    const pages = restPages(3);
    const forge = client((argv) =>
      pageOf(argv) === 2
        ? { code: 1, stdout: "", stderr: "HTTP 502\n", timedOut: false }
        : pages(argv),
    );
    await forge.run(["api", "--paginate", "repos/o/r/items"]);
    await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(4);
    expect(record.requests()).toBe(996);
    expect(forge.rows.map((r) => r.requests)).toEqual([1, 1, 1, 1]);
  });

  it("keeps the call's one deadline across its pages, keeps a page cut off by it charged, and sends none after it", async () => {
    const record = budget(1000);
    const pages = restPages(5);
    const forge = client((argv, n) => {
      // Each page takes the forge 12 of the call's 30 seconds.
      setSystemTime(currentMs() + 12_000);
      return n === 3
        ? { code: 124, stdout: "", stderr: "", timedOut: true }
        : pages(argv);
    });
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(3);
    expect(forge.sent[0]?.timeoutSec).toBe(30);
    expect(forge.sent[1]?.timeoutSec).toBeCloseTo(18, 0);
    expect(forge.sent[2]?.timeoutSec).toBeCloseTo(6, 0);
    expect(read.timedOut).toBe(true);
    expect(ghRunFailure(read)?.code).toBe("too-costly");
    expect(record.requests()).toBe(997);
  });

  it("sends no page once the deadline has passed between pages", async () => {
    budget(1000);
    const pages = restPages(5);
    const forge = client((argv) => {
      setSystemTime(currentMs() + 31_000);
      return pages(argv);
    });
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(1);
    expect(read.timedOut).toBe(true);
    expect(read.code).toBe(124);
    expect(JSON.parse(read.stdout)).toEqual([{ name: "a1" }, { name: "b1" }]);
  });

  it(`fails as too-costly past ${PAGE_CAP} pages instead of sending more`, async () => {
    const record = budget(1000);
    const forge = client(restPages(PAGE_CAP + 5));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"]);
    expect(forge.sent).toHaveLength(PAGE_CAP);
    expect(ghRunFailure(read)?.code).toBe("too-costly");
    expect(record.requests()).toBe(1000 - PAGE_CAP);
  });
});

describe("a paged GraphQL read the forge client sends a page at a time", () => {
  const query =
    "query=query($endCursor: String) { repository { items(first: 1, after: $endCursor) { nodes { n } pageInfo { hasNextPage endCursor } } } }";
  const answer = (argv: string[]): Run => {
    const field = argv.find((a) => a.startsWith("endCursor="));
    const n =
      field === undefined ? 1 : Number(field.slice("endCursor=".length)) + 1;
    const body = JSON.stringify({
      data: {
        repository: {
          items: {
            nodes: [{ n }],
            pageInfo: { hasNextPage: n < 3, endCursor: String(n) },
          },
        },
      },
    });
    return {
      code: 0,
      stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Resource: graphql\n\n${body}`,
      stderr: "",
      timedOut: false,
    };
  };

  it("asks each next page with the first pageInfo's endCursor, and gives the pages in turn or slurped", async () => {
    const record = budget(1000);
    const forge = client(answer);
    const read = await forge.run([
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      query,
    ]);
    const pages = JSON.parse(read.stdout) as unknown[];
    expect(pages).toHaveLength(3);
    expect(forge.sent.map((s) => s.argv.slice(4))).toEqual([
      ["--include"],
      ["-f", "endCursor=1", "--include"],
      ["-f", "endCursor=2", "--include"],
    ]);
    expect(forge.rows.map((r) => r.window)).toEqual([
      "complexity",
      "complexity",
      "complexity",
    ]);
    expect(record.complexity()).toBe(4997);

    const plain = await client(answer).run([
      "api",
      "graphql",
      "--paginate",
      "-f",
      query,
    ]);
    expect(plain.stdout.split("}}}}}{").length).toBe(3);
  });

  it("reads the first pageInfo in the answer's order", () => {
    expect(
      endCursorOf({
        data: {
          a: { pageInfo: { hasNextPage: true, endCursor: "first" } },
          b: { pageInfo: { hasNextPage: true, endCursor: "second" } },
        },
      }),
    ).toBe("first");
    expect(
      endCursorOf({ data: { a: { pageInfo: { hasNextPage: false } } } }),
    ).toBeNull();
  });
});

describe("a paged read left to gh, against a bounded reservation", () => {
  it("leaves streamed output, GraphQL with --jq and the caller's own --include to gh", () => {
    expect(pagePlan(["api", "--paginate", "repos/o/r/items"], false)).toBe(
      null,
    );
    expect(
      pagePlan(
        ["api", "graphql", "--paginate", "-f", "query=q", "--jq", ".data"],
        true,
      ),
    ).toBe(null);
    expect(
      pagePlan(["api", "--paginate", "--include", "repos/o/r/items"], true),
    ).toBe(null);
    expect(
      pagePlan(["api", "--paginate", "-f", "q=x", "search/issues"], true),
    ).toBe(null);
  });

  it(`reserves ${PAGINATED_RESERVE} requests above the floor before gh pages it, and keeps them`, async () => {
    const record = budget(2500 + PAGINATED_RESERVE, 0.5);
    const forge = client(() => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"], {
      stdout: "inherit",
    });
    expect(read.code).toBe(0);
    expect(forge.sent.map((s) => s.argv)).toEqual([
      ["api", "--paginate", "repos/o/r/items"],
    ]);
    expect(record.requests()).toBe(2500);
    expect(forge.rows[0]).toMatchObject({
      requests: 1,
      cost: PAGINATED_RESERVE,
      estimated: true,
    });
  });

  it("sends nothing and gives every reservation back when the window cannot hold the bound above the floor", async () => {
    const record = budget(2500 + PAGINATED_RESERVE - 1, 0.5);
    const forge = client(() => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    const read = await forge.run(["api", "--paginate", "repos/o/r/items"], {
      stdout: "inherit",
    });
    expect(forge.sent).toHaveLength(0);
    expect(ghRunFailure(read)?.code).toBe("rate-limited");
    expect(record.requests()).toBe(2500 + PAGINATED_RESERVE - 1);
  });

  it("leaves gh to page while the forge's budget is off", async () => {
    const forge = client(() => ({
      code: 0,
      stdout: "[]",
      stderr: "",
      timedOut: false,
    }));
    await forge.run(["api", "--paginate", "repos/o/r/items"], {
      env: { ...ENV, JIG_FORGE_BUDGET: "off" },
    });
    expect(forge.sent.map((s) => s.argv)).toEqual([
      ["api", "--paginate", "repos/o/r/items"],
    ]);
  });
});
