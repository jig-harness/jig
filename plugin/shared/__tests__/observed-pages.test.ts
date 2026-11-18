/**
 * `shared/outbound/observed-pages.ts`: paged REST reads shared within one
 * evaluation and revalidated page by page across evaluations.
 *
 * In-process, against a fake GitHub behind the governed forge transport
 * (`traceGhRunner`), so each page is admitted, counted and recorded in the
 * ledger as the request it is. The fake keeps lists of items, pages them by
 * `per_page`/`page`, answers `If-None-Match: <current ETag>` with a `304`
 * that carries no `Link` header (as GitHub does) and exit 1 (as `gh` does),
 * and records every request it was sent.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { setForgeGovernor } from "../outbound/github-budget.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import {
  createObservedPages,
  followingPage,
  withObservedEvaluation,
} from "../outbound/observed-pages.ts";
import { traceGhRunner } from "../trace.ts";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  bufferExceeded: boolean;
  spawnFailed: boolean;
  stderrTail: string;
  held?: OutboundFailure;
}
interface Opts {
  env?: Record<string, string | undefined>;
  timeoutSec?: number;
  cwd?: string;
  stderr?: "pipe" | "inherit" | "ignore";
}

const ENV = { GH_TOKEN: "observed-pages-test" };
const API = "https://api.github.com/";
const COMMENTS = "repos/o/r/issues/7/comments?per_page=2";
const CHECKS = (sha: string) =>
  `repos/o/r/commits/${sha}/check-runs?per_page=2`;

interface Sent {
  url: string;
  ifNoneMatch: string | null;
  status: number;
}

/** A GitHub that pages lists of items and validates ETags. */
function fakeGitHub() {
  const lists = new Map<string, unknown[]>();
  /** Listings answered as an object around their items (`check_runs`). */
  const wrapped = new Map<string, string>();
  const sent: Sent[] = [];
  /** Answer a request differently: return a run to send instead. */
  let override: ((url: string, inm: string | null) => Run | undefined) | null =
    null;

  function page(url: string) {
    const bare = url.startsWith(API) ? url.slice(API.length) : url;
    const [route = "", query = ""] = bare.split("?");
    const params = new URLSearchParams(query);
    const perPage = Number(params.get("per_page") ?? "30");
    const n = Number(params.get("page") ?? "1");
    const all = lists.get(route) ?? [];
    const items = all.slice((n - 1) * perPage, n * perPage);
    const key = wrapped.get(route);
    const body = JSON.stringify(
      key === undefined ? items : { total_count: all.length, [key]: items },
    );
    const next =
      n * perPage < all.length
        ? `<${API}${route}?per_page=${perPage}&page=${n + 1}>; rel="next"`
        : null;
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    return { body, next, etag };
  }

  async function answer(argv: string[]): Promise<Run> {
    const url =
      argv.find((a) => a.startsWith("repos/") || a.startsWith(API)) ?? "";
    const header = argv.find((a) => a.startsWith("If-None-Match: "));
    const inm = header === undefined ? null : header.slice(15);
    const forced = override?.(url, inm);
    const base = {
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
    };
    if (forced !== undefined) {
      sent.push({ url, ifNoneMatch: inm, status: forced.code === 0 ? 200 : 0 });
      return forced;
    }
    const { body, next, etag } = page(url);
    if (inm === etag) {
      sent.push({ url, ifNoneMatch: inm, status: 304 });
      return {
        ...base,
        code: 1,
        stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\nX-Ratelimit-Resource: core\r\n\r\n`,
        stderr: "gh: HTTP 304\n",
        stderrTail: "gh: HTTP 304",
      };
    }
    sent.push({ url, ifNoneMatch: inm, status: 200 });
    return {
      ...base,
      code: 0,
      stdout: `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\n${next === null ? "" : `Link: ${next}\r\n`}X-Ratelimit-Resource: core\r\n\r\n${body}`,
      stderr: "",
      stderrTail: "",
    };
  }

  return {
    lists,
    wrapped,
    sent,
    answer,
    set override(fn: typeof override) {
      override = fn;
    },
    /** The items of a list, as a whole read would print its pages. */
    slurped(path: string): unknown[] {
      const route = path.split("?")[0] ?? "";
      const perPage = Number(
        new URLSearchParams(path.split("?")[1] ?? "").get("per_page") ?? "30",
      );
      const all = lists.get(route) ?? [];
      const pages: unknown[] = [];
      for (let i = 0; i === 0 || i < all.length; i += perPage) {
        const items = all.slice(i, i + perPage);
        const key = wrapped.get(route);
        pages.push(
          key === undefined ? items : { total_count: all.length, [key]: items },
        );
      }
      return pages;
    },
  };
}

let dir: string;
let github: ReturnType<typeof fakeGitHub>;
let rows: CallRecord[];
let cacheOn: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "observed-pages-"));
  github = fakeGitHub();
  rows = [];
  cacheOn = true;
  setForgeGovernor(budgetGovernor(memoryBudgetStore(), { share: () => null }));
});

afterEach(() => {
  setForgeGovernor(null);
  rmSync(dir, { recursive: true, force: true });
});

function reader() {
  const ghCall = traceGhRunner<Run, Opts>(
    (argv) => github.answer(argv),
    () => 30,
    { env: ENV },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: `${failure.reason}\n`,
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: failure.reason,
      held: failure,
    }),
  );
  const { ghObservedSlurp } = createObservedPages({
    ghCall,
    defaultTimeoutSec: () => 30,
    cacheDir: () => (cacheOn ? dir : null),
    repoScope: async () => "scope",
  });
  return (path: string) =>
    withLedgerWriter(
      (row) => rows.push(row),
      () => ghObservedSlurp(path, { env: ENV }),
    );
}

const items = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));
const route = (path: string) => path.split("?")[0] ?? "";
const json = (r: { stdout: string }): unknown => JSON.parse(r.stdout);

describe("observed paged reads", () => {
  it("bounds sequential pages and scope resolution by the transport's default whole-resource deadline", async () => {
    github.lists.set(route(COMMENTS), items("c", 10));
    let now = 1_800_000_000_000;
    const advance = () => {
      now += 400;
      setSystemTime(now);
    };
    setSystemTime(now);
    const budgets: Array<number | undefined> = [];
    const { ghObservedSlurp } = createObservedPages({
      defaultTimeoutSec: () => 1,
      cacheDir: () => dir,
      repoScope: async () => {
        advance();
        return "scope";
      },
      ghCall: async (argv, opts) => {
        budgets.push(opts?.timeoutSec);
        advance();
        return github.answer(argv);
      },
    });
    try {
      const result = await ghObservedSlurp(COMMENTS, { env: ENV });
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe(124);
      expect(github.sent).toHaveLength(2);
      expect(budgets).toEqual([1, 1]);
    } finally {
      setSystemTime();
    }
  });

  it("a second evaluation over an unchanged resource sends only conditional requests, each answered 304, and reuses the earlier reading", async () => {
    github.lists.set(route(COMMENTS), items("c", 5));
    const read = reader();
    const first = await read(COMMENTS);
    expect(first.code).toBe(0);
    expect(json(first)).toEqual(github.slurped(COMMENTS));
    // Three pages, then the page after the last once, to keep its ETag.
    expect(github.sent.map((s) => s.status)).toEqual([200, 200, 200, 200]);
    github.sent.length = 0;
    rows.length = 0;

    const second = await read(COMMENTS);
    expect(second).toEqual(first);
    expect(github.sent).toHaveLength(4);
    for (const s of github.sent) {
      expect(s.ifNoneMatch).not.toBeNull();
      expect(s.status).toBe(304);
    }
  });

  it("the ledger counts each route's 304 answers apart from its 200s", async () => {
    github.lists.set(route(COMMENTS), items("c", 3));
    const read = reader();
    await read(COMMENTS);
    github.lists.get(route(COMMENTS))?.push({ id: "c4" });
    rows.length = 0;
    await read(COMMENTS);
    // Page 1 is unchanged (304); page 2 gained an item (200) and its own
    // `Link` says nothing follows it.
    expect(rows.map((r) => r.operation)).toEqual([
      "GET /repos/{}/{}/issues/{}/comments",
      "GET /repos/{}/{}/issues/{}/comments",
    ]);
    expect(rows.map((r) => [r.requests, r.notModified, r.cost])).toEqual([
      [1, 1, 0],
      [1, 0, 1],
    ]);
  });

  it("one evaluation reads each resource once, however many readers ask", async () => {
    github.lists.set(route(COMMENTS), items("c", 3));
    github.lists.set(route(CHECKS("a".repeat(40))), items("r", 1));
    github.wrapped.set(route(CHECKS("a".repeat(40))), "check_runs");
    const read = reader();
    await withObservedEvaluation(async () => {
      const answers = await Promise.all([
        read(COMMENTS),
        read(COMMENTS),
        read(CHECKS("a".repeat(40))),
        read(CHECKS("a".repeat(40))),
      ]);
      expect(answers.every((a) => a.code === 0)).toBe(true);
      expect(json(answers[0] as Run)).toEqual(json(answers[1] as Run));
      await read(COMMENTS);
    });
    const comments = github.sent.filter((s) => s.url.includes("/comments"));
    const checks = github.sent.filter((s) => s.url.includes("/check-runs"));
    // Two pages and the tail, once; one page and the tail, once.
    expect(comments).toHaveLength(3);
    expect(checks).toHaveLength(2);

    github.sent.length = 0;
    await withObservedEvaluation(() => read(COMMENTS));
    await withObservedEvaluation(() => read(COMMENTS));
    // A new evaluation reads again; nothing is shared across evaluations.
    expect(github.sent).toHaveLength(6);
  });

  it("a change on a later page is read, and the pages around it are reused", async () => {
    github.lists.set(route(COMMENTS), items("c", 5));
    const read = reader();
    await read(COMMENTS);
    github.sent.length = 0;
    const list = github.lists.get(route(COMMENTS)) ?? [];
    list[2] = { id: "c3", edited: true };
    const second = await read(COMMENTS);
    expect(json(second)).toEqual(github.slurped(COMMENTS));
    expect(github.sent.map((s) => s.status)).toEqual([304, 200, 304, 304]);
  });

  it("a new comment on a part-full last page is read", async () => {
    github.lists.set(route(COMMENTS), items("c", 3));
    const read = reader();
    await read(COMMENTS);
    github.lists.get(route(COMMENTS))?.push({ id: "c4" });
    const second = await read(COMMENTS);
    expect(json(second)).toEqual([
      [{ id: "c1" }, { id: "c2" }],
      [{ id: "c3" }, { id: "c4" }],
    ]);
  });

  it("a new page after a full last page is seen", async () => {
    github.lists.set(route(COMMENTS), items("c", 4));
    const read = reader();
    await read(COMMENTS);
    github.sent.length = 0;
    github.lists.get(route(COMMENTS))?.push({ id: "c5" });
    const second = await read(COMMENTS);
    expect(json(second)).toEqual(github.slurped(COMMENTS));
    expect(json(second)).toHaveLength(3);
    // Both full pages are unchanged; the probe of page 3 finds the new item,
    // and page 4 is asked once to keep its ETag.
    expect(github.sent.map((s) => s.status)).toEqual([304, 304, 200, 200]);
    expect(github.sent[2]?.ifNoneMatch).not.toBeNull();
    github.sent.length = 0;
    // The new page joined the chain: the next reading is 304s alone.
    expect(await read(COMMENTS)).toEqual(second);
    expect(github.sent.map((s) => s.status)).toEqual([304, 304, 304, 304]);
  });

  it("a new check run is read, and a new head commit's listing is read whole", async () => {
    const sha = "a".repeat(40);
    github.lists.set(route(CHECKS(sha)), items("r", 2));
    github.wrapped.set(route(CHECKS(sha)), "check_runs");
    const read = reader();
    await read(CHECKS(sha));
    github.lists.get(route(CHECKS(sha)))?.push({ id: "r3" });
    const second = await read(CHECKS(sha));
    expect(json(second)).toEqual(github.slurped(CHECKS(sha)));

    const head = "b".repeat(40);
    github.lists.set(route(CHECKS(head)), items("s", 1));
    github.wrapped.set(route(CHECKS(head)), "check_runs");
    github.sent.length = 0;
    const other = await read(CHECKS(head));
    expect(json(other)).toEqual(github.slurped(CHECKS(head)));
    expect(github.sent.every((s) => s.ifNoneMatch === null)).toBe(true);
  });

  it("a transport failure falls back to a whole read, never to the kept reading", async () => {
    github.lists.set(route(COMMENTS), items("c", 5));
    const read = reader();
    await read(COMMENTS);
    github.lists.get(route(COMMENTS))?.push({ id: "c6" });
    github.sent.length = 0;
    let failed = false;
    github.override = (url, inm) => {
      if (failed || inm === null || !url.includes("page=2")) return undefined;
      failed = true;
      return {
        code: 1,
        stdout: "",
        stderr: "error connecting to api.github.com\n",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "error connecting to api.github.com",
      };
    };
    const second = await read(COMMENTS);
    expect(second.code).toBe(0);
    expect(json(second)).toEqual(github.slurped(COMMENTS));
    // The whole read after the failure asks every page with no ETag.
    const after = github.sent.slice(2);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.ifNoneMatch === null)).toBe(true);
  });

  it("a whole read that fails too is answered as that failure", async () => {
    github.lists.set(route(COMMENTS), items("c", 3));
    const read = reader();
    await read(COMMENTS);
    github.override = () => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 404: Not Found\n",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "HTTP 404: Not Found",
    });
    const second = await read(COMMENTS);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("404");
  });

  it("a truncated page falls back to a whole read", async () => {
    github.lists.set(route(COMMENTS), items("c", 5));
    const read = reader();
    await read(COMMENTS);
    github.lists.get(route(COMMENTS))?.push({ id: "c6" });
    let cut = false;
    github.override = (url, inm) => {
      if (cut || inm === null || !url.includes("page=3")) return undefined;
      cut = true;
      return {
        code: 0,
        stdout: 'HTTP/2.0 200 OK\r\nEtag: "x"\r\n\r\n[{"id":"c5"},{"id"',
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "",
      };
    };
    const second = await read(COMMENTS);
    expect(second.code).toBe(0);
    expect(json(second)).toEqual(github.slurped(COMMENTS));
  });

  it("a 304 with no kept reading falls back to a whole read", async () => {
    github.lists.set(route(COMMENTS), items("c", 3));
    let once = false;
    github.override = (_url, inm) => {
      if (once || inm !== null) return undefined;
      once = true;
      return {
        code: 1,
        stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n',
        stderr: "gh: HTTP 304\n",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "gh: HTTP 304",
      };
    };
    const first = await reader()(COMMENTS);
    expect(first.code).toBe(0);
    expect(json(first)).toEqual(github.slurped(COMMENTS));
  });

  it("a failed reading is not shared: the next ask in the evaluation reads again", async () => {
    github.lists.set(route(COMMENTS), items("c", 1));
    const read = reader();
    github.override = () => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 404: Not Found\n",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "HTTP 404: Not Found",
    });
    await withObservedEvaluation(async () => {
      expect((await read(COMMENTS)).code).not.toBe(0);
      github.override = null;
      const again = await read(COMMENTS);
      expect(again.code).toBe(0);
      expect(json(again)).toEqual(github.slurped(COMMENTS));
    });
  });

  it("with caching off, it is the caller's own whole read", async () => {
    cacheOn = false;
    github.lists.set(route(COMMENTS), items("c", 3));
    const read = reader();
    expect(json(await read(COMMENTS))).toEqual(github.slurped(COMMENTS));
    expect(json(await read(COMMENTS))).toEqual(github.slurped(COMMENTS));
    expect(github.sent.every((s) => s.ifNoneMatch === null)).toBe(true);
    expect(github.sent).toHaveLength(4);
  });

  it("shares whole reads within an evaluation when disk caching is off", async () => {
    cacheOn = false;
    github.lists.set(route(COMMENTS), items("c", 3));
    const read = reader();

    await withObservedEvaluation(async () => {
      const [first, second] = await Promise.all([
        read(COMMENTS),
        read(COMMENTS),
      ]);
      expect(first).toEqual(second);
    });

    expect(github.sent).toHaveLength(2);
  });
});

describe("followingPage", () => {
  it("numbers the page after a URL, the first page being 1", () => {
    expect(followingPage("repos/o/r/issues/7/comments?per_page=100")).toBe(
      "repos/o/r/issues/7/comments?per_page=100&page=2",
    );
    expect(followingPage(`${API}repositories/1/x?per_page=2&page=4`)).toBe(
      `${API}repositories/1/x?per_page=2&page=5`,
    );
  });
  it("cannot number a page named by a cursor", () => {
    expect(followingPage("repos/o/r/stacks?per_page=100&after=abc")).toBeNull();
  });
});
