/**
 * The comment listing a tick reads each pull request's comments with
 * (`records/comment-pages.ts`): page by page, each page revalidated against
 * the body kept with its `ETag`. Against an in-process `gh` that answers as
 * GitHub does (a weak `ETag` on `200`, `304` and exit 1 for a current one),
 * run through the governed runner so the cost ledger records each request.
 */
import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionalCache } from "../gh-conditional.ts";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { setForgeGovernor } from "../outbound/github-budget.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { ok } from "../outcome.ts";
import { heldRun, type RunOptions, type RunResult } from "../proc.ts";
import { commentPages } from "../records/comment-pages.ts";
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
