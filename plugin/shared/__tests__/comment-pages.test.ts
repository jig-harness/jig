/**
 * The comment listing a tick reads each pull request's comments with
 * (`records/comment-pages.ts`): page by page, each page revalidated against
 * the body kept with its `ETag`. Against an in-process `gh` that answers as
 * GitHub does (a weak `ETag` on `200`, `304` and exit 1 for a current one),
 * run through the governed runner so the cost ledger records each request.
 */
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionalCache } from "../gh-conditional.ts";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { setForgeGovernor } from "../outbound/github-budget.ts";
import { outboundFailure } from "../outbound/failure.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { ok } from "../outcome.ts";
import { heldRun, type RunOptions, type RunResult } from "../proc.ts";
import { commentPages, reviewCommentPages } from "../records/comment-pages.ts";
import { currentMs } from "../time.ts";
import { traceGhRunner } from "../trace.ts";

afterEach(() => setForgeGovernor(null));

const TARGET = { repo: "acme/app", number: 7 };

/** A forge holding `count` comments on the pull request, and the requests it was sent. */
function forge(count: number) {
  let comments = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    body: `comment ${i + 1}`,
  }));
  const sent: string[] = [];
  const answer = (args: string[]): RunResult => {
    const path = args.at(-1) ?? "";
    const header = args.find((a) => a.startsWith("If-None-Match: "));
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    const body = JSON.stringify(comments.slice((page - 1) * 100, page * 100));
    const tag = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const base = {
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "",
    };
    if (header === `If-None-Match: W/"${tag}"`) {
      sent.push(`${page} 304`);
      return {
        ...base,
        code: 1,
        stdout: `HTTP/2.0 304 Not Modified\r\nEtag: "${tag}"\r\n\r\n`,
        stderr: "gh: HTTP 304",
      };
    }
    sent.push(`${page} 200`);
    return {
      ...base,
      code: 0,
      stdout: `HTTP/2.0 200 OK\r\nEtag: W/"${tag}"\r\n\r\n${body}`,
      stderr: "",
    };
  };
  setForgeGovernor(budgetGovernor(memoryBudgetStore(), { share: () => null }));
  const ghCall = traceGhRunner<RunResult, RunOptions>(
    async (args) => answer(args),
    () => 10,
    { env: { GH_TOKEN: "comment-pages-test" } },
    heldRun,
  );
  const dir = mkdtempSync(join(tmpdir(), "comment-pages-"));
  const cache = createConditionalCache({
    ghCall,
    git: async () => {
      throw new Error("a listing that names its repository reads no checkout");
    },
    cacheDir: () => dir,
  });
  const plain: string[] = [];
  const list = commentPages({
    ghCacheDir: cache.ghCacheDir,
    ghConditionalGet: cache.ghConditionalGet,
    plain: async (target) => {
      plain.push(`#${target.number}`);
      return ok([]);
    },
  });
  return {
    sent,
    plain,
    add: () => {
      comments = [
        ...comments,
        { id: comments.length + 1, body: `comment ${comments.length + 1}` },
      ];
    },
    read: async () => {
      const events: CallRecord[] = [];
      const mark = sent.length;
      const listing = await withLedgerWriter(
        (event) => events.push(event),
        () => list(TARGET, { timeoutSec: 30 }),
      );
      return { listing, events, sent: sent.slice(mark) };
    },
  };
}

it("reuses the kept pages GitHub answers 304, recorded as costing nothing", async () => {
  const f = forge(150);
  const first = await f.read();
  expect(first.sent).toEqual(["1 200", "2 200"]);
  expect(first.listing.ok && first.listing.value).toHaveLength(150);
  expect(first.events.map((e) => e.cost)).toEqual([1, 1]);
  const again = await f.read();
  expect(again.sent).toEqual(["1 304", "2 304"]);
  expect(again.listing).toEqual(first.listing);
  expect(again.events).toHaveLength(2);
  for (const event of again.events)
    expect(event).toMatchObject({
      system: "github",
      requests: 1,
      cost: 0,
      estimated: false,
      failure: null,
    });
  expect(f.plain).toEqual([]);
});

it("reads again only the page a new comment changed", async () => {
  const f = forge(150);
  await f.read();
  f.add();
  const changed = await f.read();
  expect(changed.sent).toEqual(["1 304", "2 200"]);
  expect(changed.events.map((e) => e.cost)).toEqual([0, 1]);
  expect(changed.listing.ok && changed.listing.value).toHaveLength(151);
});

it("asks the page after a full one, so a comment that opens a new page is seen", async () => {
  const f = forge(100);
  expect((await f.read()).sent).toEqual(["1 200", "2 200"]);
  f.add();
  const grown = await f.read();
  expect(grown.sent).toEqual(["1 304", "2 200"]);
  expect(grown.listing.ok && grown.listing.value).toHaveLength(101);
});

it("reads the plain paged listing where no cache is kept", async () => {
  const list = commentPages({
    ghCacheDir: () => null,
    ghConditionalGet: async () => {
      throw new Error("no conditional read without a cache");
    },
    plain: async () => ok([{ id: 1 }]),
  });
  expect(await list(TARGET)).toEqual(ok([{ id: 1 }]));
});

it("reads a {owner}/{repo} placeholder target with the plain read", async () => {
  const list = commentPages({
    ghCacheDir: () => "/cache",
    ghConditionalGet: async () => {
      throw new Error("a placeholder target is never a named scope");
    },
    plain: async () => ok([{ id: 2 }]),
  });
  expect(await list({ repo: "{owner}/{repo}", number: 1 })).toEqual(
    ok([{ id: 2 }]),
  );
});

it("lists a pull request's review comments page by page", async () => {
  const asked: string[] = [];
  const list = reviewCommentPages({
    ghCacheDir: () => "/cache",
    ghConditionalGet: async (path) => {
      asked.push(path);
      const full = asked.length === 1;
      return {
        ok: true,
        changed: false,
        body: JSON.stringify(full ? Array(100).fill({ id: 1 }) : [{ id: 2 }]),
      };
    },
  });
  const read = await list(TARGET);
  expect(read.ok && read.value.length).toBe(101);
  expect(asked).toEqual([
    "repos/acme/app/pulls/7/comments?per_page=100&page=1",
    "repos/acme/app/pulls/7/comments?per_page=100&page=2",
  ]);
});

it("does not read review comments it cannot revalidate or that run past the last page", async () => {
  const never = async (): Promise<never> => {
    throw new Error("no conditional read without a cache");
  };
  const uncached = reviewCommentPages({
    ghCacheDir: () => null,
    ghConditionalGet: never,
  });
  expect((await uncached(TARGET)).ok).toBe(false);
  const placeholder = reviewCommentPages({
    ghCacheDir: () => "/cache",
    ghConditionalGet: never,
  });
  expect((await placeholder({ repo: "{owner}/{repo}", number: 1 })).ok).toBe(
    false,
  );
  const endless = reviewCommentPages({
    ghCacheDir: () => "/cache",
    ghConditionalGet: async () => ({
      ok: true,
      changed: false,
      body: JSON.stringify(Array(100).fill({ id: 1 })),
    }),
  });
  const read = await endless(TARGET);
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.failure.reason).toContain("pages");
});

it("keeps a page GitHub answered 304 through a prune that removes older entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comment-pages-prune-"));
  const bodies = new Map([
    ["a", "[1]"],
    ["b", "[2]"],
    ["c", "[3]"],
  ]);
  const ghCall = async (args: string[]): Promise<RunResult> => {
    const path = args.at(-1) ?? "";
    const body = bodies.get(path) ?? "[]";
    const tag = `W/"${path}"`;
    const base = {
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "",
    };
    return args.includes(`If-None-Match: ${tag}`)
      ? {
          ...base,
          code: 1,
          stdout: `HTTP/2.0 304 Not Modified\r\nEtag: "${path}"\r\n\r\n`,
          stderr: "gh: HTTP 304",
        }
      : {
          ...base,
          code: 0,
          stdout: `HTTP/2.0 200 OK\r\nEtag: ${tag}\r\n\r\n${body}`,
          stderr: "",
        };
  };
  const cache = createConditionalCache({
    ghCall,
    git: async () => {
      throw new Error("no checkout is read");
    },
    cacheDir: () => dir,
    entries: { max: 2, keep: 2 },
  });
  const get = (path: string) =>
    cache.ghConditionalGet(path, { repository: "acme/app" });
  // "a" is two hours old, "b" one hour: "a" would be pruned first.
  const age = (seen: Set<string>, hours: number) => {
    const at = currentMs() / 1000 - hours * 3600;
    for (const name of readdirSync(dir))
      if (!seen.has(name)) {
        utimesSync(join(dir, name), at, at);
        seen.add(name);
      }
  };
  const seen = new Set<string>();
  expect(await get("a")).toMatchObject({ ok: true, changed: true });
  age(seen, 2);
  expect(await get("b")).toMatchObject({ ok: true, changed: true });
  age(seen, 1);
  // Then "a" is revalidated.
  expect(await get("a")).toMatchObject({ ok: true, changed: false });
  // A third entry prunes the cache to its two newest.
  expect(await get("c")).toMatchObject({ ok: true, changed: true });
  expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(2);
  expect(await get("a")).toMatchObject({ ok: true, changed: false });
  expect(await get("b")).toMatchObject({ ok: true, changed: true });
});

it("says a request the shared budget refused was not sent, with its class", async () => {
  const refusal = outboundFailure(
    "rate-limited",
    "the forge's budget is spent",
  );
  const cache = createConditionalCache({
    ghCall: async () => heldRun(refusal),
    git: async () => {
      throw new Error("no checkout is read");
    },
    cacheDir: () => mkdtempSync(join(tmpdir(), "comment-pages-held-")),
  });
  const read = await cache.ghConditionalGet(
    "repos/acme/app/issues/7/comments",
    {
      repository: "acme/app",
    },
  );
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.reason).toContain("was not sent");
  expect(read.reason).toContain("the forge's budget is spent");
  expect(read.failure?.code).toBe("rate-limited");
});

it("names the page whose body is not JSON, and keeps the parse error as the cause", async () => {
  const list = commentPages({
    ghCacheDir: () => "/unused",
    ghConditionalGet: async () => ({ ok: true, changed: false, body: "{" }),
    plain: async () => ok([]),
  });
  const read = await list(TARGET);
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.failure.reason).toContain("page 1");
  expect(read.failure.reason).toContain("kept");
  expect(read.failure.cause).toBeInstanceOf(SyntaxError);
});
