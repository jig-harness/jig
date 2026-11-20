/**
 * Observed paged REST reads: what `gh api --paginate --slurp <path>` prints
 * (a JSON array of the pages), read so that a resource nobody changed costs
 * nothing against GitHub's primary REST limit and one evaluation reads it
 * once.
 *
 * - **Within one evaluation** (`withObservedEvaluation`), every ask for the
 *   same resource (the resolved repository scope and path) shares one reading.
 *   A failed reading is not kept: the next ask
 *   reads again. Outside an evaluation nothing is shared, so a long-lived
 *   process that polls never answers from an earlier poll.
 * - **Across evaluations**, every page is kept on disk with its URL, ETag,
 *   body and next link, in the forge's conditional-request cache
 *   (`gh-conditional.ts`'s directory, scope and switches). The next reading
 *   asks for each page with `If-None-Match`: a `304` reuses the kept body and
 *   the kept next link (GitHub sends no `Link` header with a `304`), a `200`
 *   takes the new body and its own `Link`. The walk follows the chain page by
 *   page, at most `PAGE_CAP` pages, on the API origin only.
 * - **A page added after the last one** leaves the last page's own ETag
 *   unchanged, so a last page answered `304` is followed by a conditional ask
 *   for the page after it by number (the **tail probe**): a `304`, or an
 *   empty answer, says nothing was added; items say a page was, and the walk
 *   goes on from it. The first reading of a last page asks the tail once
 *   too, only to keep its ETag, so an unchanged resource is answered by
 *   `304`s alone from the next evaluation on. Pages named by a cursor rather
 *   than a number cannot be probed, so an unchanged last page of those is
 *   read whole.
 *
 * FAIL CLOSED. A transport failure, a timeout, an answer that does not
 * parse, a `304` with no kept page, a next page this reader cannot name, or
 * more than `PAGE_CAP` pages is never read as "unchanged": the resource is
 * read again whole, with no `If-None-Match`, exactly as the caller read it
 * before (`gh api --paginate --slurp`), and that read's failure is the
 * answer. A cache problem only makes a read cost more, never makes it wrong.
 *
 * A `304` is GitHub's confirmation that the page is current, so a walk
 * answered by `304`s is as fresh as one answered by `200`s. What is not fresh
 * is the evaluation's shared reading: a read that guards a write, a resolve
 * or an announcement does not take it (it reads with its own `gh api` call).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { definedFields } from "../defined-fields.ts";
import { swallow } from "../errors.ts";
import {
  CACHE_RETENTION_MS,
  entryFile,
  readJsonFile,
  touchFile,
  writeJsonFile,
} from "../gh-cache-storage.ts";
import { log } from "../log.ts";
import { currentMs } from "../time.ts";
import { coalesce } from "./coalesce.ts";
import { type OutboundFailure, outboundFailure } from "./failure.ts";
import { PAGE_CAP, nextPageUrl } from "./gh-paginate.ts";
import { forgeBudgetOn, splitHeaders } from "./github-budget.ts";

/** The answer of an observed read: the fields a `gh` run reports. */
export interface ObservedRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  bufferExceeded: boolean;
  spawnFailed: boolean;
  stderrTail: string;
  /** How many pages the read got through before it ended. */
  pagesRead?: number;
  /** The failure of a read the forge client or this reader refused to go on with. */
  held?: OutboundFailure;
}

/** How far a walk got: the pages kept, and whether more lie past `PAGE_CAP`. */
interface WalkProgress {
  pages: number;
  overCap: boolean;
}

/** Where and how the read runs; the same fields the caller's `gh` call took. */
export interface ObservedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Whole seconds the whole read may take, cache probes and pages included.
   * Longer than the transport's own deadline, it is the listing's bound, and
   * each page keeps that deadline.
   */
  timeoutSec?: number;
  /** Sent as `X-Drive-Pr-Caller` on each page, so a test double tells callers apart. */
  caller?: string;
  /** The caller's error-output handling, kept for the whole read it falls back to. */
  stderr?: "pipe" | "inherit" | "ignore";
}

type GhCall<R extends ObservedRun> = (
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutSec?: number;
    pagedWholeSec?: number;
    stderr?: "pipe" | "inherit" | "ignore";
  },
) => Promise<R>;

/** What the reader needs of the conditional-request cache it shares. */
export interface ObservedDeps<R extends ObservedRun> {
  ghCall: GhCall<R>;
  /** The bound transport's default deadline, applied to the whole resource. */
  defaultTimeoutSec: () => number;
  /** The cache directory, or null when caching is off. */
  cacheDir: () => string | null;
  /** The repository scope a call in `ctx` reads, or null when it cannot be known. */
  repoScope: (ctx: ObservedOptions) => Promise<string | null>;
}

const evaluation = new AsyncLocalStorage<Map<string, Promise<ObservedRun>>>();

/**
 * How long past its budget the caller that started a reading waits for it.
 * That reading stops itself at the budget, and its answer says how far it got.
 */
const OWN_READ_GRACE_MS = 5_000;

/** How far each shared reading has got, for a caller whose budget ends first. */
const walks = new WeakMap<Promise<ObservedRun>, WalkProgress>();

/**
 * Run `fn` as one evaluation: the observed reads it makes, however many
 * modules ask, read each resource once. Nested, the inner one starts afresh.
 */
export function withObservedEvaluation<T>(fn: () => T): T {
  return evaluation.run(new Map(), fn);
}

const ENTRY_VERSION = 2;

interface KeptPage {
  url: string;
  etag: string;
  body: string;
  next: string | null;
}

interface Entry {
  /** When this complete resource was last acquired, never extended by page reuse. */
  acquiredAt: number;
  pages: KeptPage[];
  /** The page after the last one, as last asked: an ETag for its empty answer. */
  tail: { url: string; etag: string } | null;
}

const isString = (v: unknown): v is string => typeof v === "string";

function keptPage(v: unknown): KeptPage | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (
    !isString(p.url) ||
    !isString(p.etag) ||
    !isString(p.body) ||
    pageItems(p.body) === null
  )
    return null;
  if (p.next !== null && !isString(p.next)) return null;
  return { url: p.url, etag: p.etag, body: p.body, next: p.next };
}

/** A kept entry for `request`, or null when there is none or it does not read whole. */
function readEntry(file: string, request: string): Entry | null {
  const e = readJsonFile(file);
  if (e === null || e.v !== ENTRY_VERSION || e.request !== request) return null;
  if (
    typeof e.acquiredAt !== "number" ||
    !Number.isFinite(e.acquiredAt) ||
    currentMs() - e.acquiredAt >= CACHE_RETENTION_MS
  )
    return null;
  if (!Array.isArray(e.pages)) return null;
  const pages = e.pages.map(keptPage);
  if (pages.some((p) => p === null)) return null;
  const t = e.tail as Record<string, unknown> | null | undefined;
  const tail =
    t && isString(t.url) && isString(t.etag)
      ? { url: t.url, etag: t.etag }
      : null;
  return { acquiredAt: e.acquiredAt, pages: pages as KeptPage[], tail };
}

/** How many items a page holds: its array, or an object's first array (`check_runs`); null when neither. */
function pageItems(body: string): number | null {
  try {
    const v: unknown = JSON.parse(body);
    if (Array.isArray(v)) return v.length;
    if (typeof v !== "object" || v === null) return null;
    const list = Object.values(v).find(Array.isArray);
    return list === undefined ? null : list.length;
  } catch (error) {
    swallow(error, "a page that is not JSON holds no countable items");
    return null;
  }
}

/** Query parameters that name a cursor, whose following page cannot be numbered. */
const CURSORS = ["after", "before", "cursor", "page_token"];

/**
 * The page after `url` by its page number (`page=N+1`, the first page being
 * 1); null for a URL whose pages are not numbered.
 */
export function followingPage(url: string): string | null {
  const at = url.indexOf("?");
  const base = at < 0 ? url : url.slice(0, at);
  const params = new URLSearchParams(at < 0 ? "" : url.slice(at + 1));
  if (CURSORS.some((c) => params.has(c))) return null;
  const page = params.get("page") ?? "1";
  if (!/^\d+$/.test(page)) return null;
  params.set("page", String(Number(page) + 1));
  return `${base}?${params.toString()}`;
}

/** The first page's URL: GitHub's largest page unless the caller chose one, as gh asks it. */
function firstPage(path: string): string {
  return /[?&]per_page=/.test(path)
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
}

type LiveAnswer = {
  status: 200;
  etag: string;
  body: string;
  next: string | null;
};
type PageAnswer = LiveAnswer | { status: 304 };

const ok = (stdout: string): ObservedRun => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  bufferExceeded: false,
  spawnFailed: false,
  stderrTail: "",
});

/** Keep a rejected page's diagnostic when the caller retries the whole list. */
function rejectedPage(result: ObservedRun, reason: string): null {
  log.debug("conditional page rejected; reading the resource whole", {
    reason,
    code: result.code,
    stderrTail: result.stderrTail,
    timedOut: result.timedOut,
    bufferExceeded: result.bufferExceeded,
    spawnFailed: result.spawnFailed,
  });
  return null;
}

const spent = (path: string, pagesRead?: number): ObservedRun => {
  const reason = `gh api ${path}: caller budget exhausted`;
  return {
    code: 124,
    stdout: "",
    stderr: `${reason}\n`,
    timedOut: true,
    bufferExceeded: false,
    spawnFailed: false,
    stderrTail: reason,
    ...(pagesRead === undefined ? {} : { pagesRead }),
  };
};

/** A resource with more pages than a read takes, as the forge client refuses one. */
function overCap(path: string): ObservedRun {
  const reason = `gh api ${path}: more than ${PAGE_CAP} pages; sent no more after page ${PAGE_CAP}`;
  return {
    code: 1,
    stdout: "",
    stderr: `${reason}\n`,
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
    stderrTail: reason,
    pagesRead: PAGE_CAP,
    held: outboundFailure("too-costly", reason, { sent: true }),
  };
}

/** Bind observed reads to a conditional-request cache and its process transport. */
export function createObservedPages<R extends ObservedRun>(
  deps: ObservedDeps<R>,
) {
  const { ghCall } = deps;

  /** Whole seconds left of the caller's budget; 0 once spent, undefined with none. */
  function leftSec(ctx: ObservedOptions, startMs: number): number | undefined {
    if (ctx.timeoutSec === undefined) return undefined;
    return Math.max(
      0,
      Math.ceil(ctx.timeoutSec - (currentMs() - startMs) / 1000),
    );
  }

  /** One page, conditional on `etag` when one is given; null for any answer that is not a whole 200 or 304. */
  async function readPage(
    url: string,
    etag: string | null,
    ctx: ObservedOptions,
    left: number | undefined,
  ): Promise<PageAnswer | null> {
    const r = await ghCall(
      [
        "api",
        "-i",
        ...(etag ? ["-H", `If-None-Match: ${etag}`] : []),
        ...(ctx.caller ? ["-H", `X-Drive-Pr-Caller: ${ctx.caller}`] : []),
        url,
      ],
      definedFields({ cwd: ctx.cwd, env: ctx.env, timeoutSec: left }),
    );
    if (r.timedOut || r.bufferExceeded || r.spawnFailed)
      return rejectedPage(r, "transport did not complete");
    const status = /^HTTP\/\S+\s+(\d{3})/.exec(r.stdout);
    if (!status) return rejectedPage(r, "missing HTTP status");
    const { headers, body } = splitHeaders(r.stdout);
    // `gh api` exits 1 on a 304, so the status line decides, not the exit.
    if (status[1] === "304")
      return etag
        ? { status: 304 }
        : rejectedPage(r, "304 without a validator");
    if (status[1] !== "200" || r.code !== 0 || pageItems(body) === null)
      return rejectedPage(r, "response was not a whole JSON page");
    const next = nextPageUrl(headers, ctx.env ?? process.env);
    if (
      /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(headers?.get("link") ?? "") &&
      next === null
    )
      return rejectedPage(r, "next page is not safe to follow");
    return {
      status: 200,
      etag: headers?.get("etag") ?? "",
      body,
      next,
    };
  }

  /**
   * Walk the chain from the first page, each page asked with the ETag kept
   * for its URL, then the tail probe. The pages read and the tail asked, or
   * null when any step cannot be trusted.
   */
  async function walk(
    path: string,
    kept: Entry | null,
    ctx: ObservedOptions,
    startMs: number,
    progress: WalkProgress,
  ): Promise<{ entry: Entry; changed: boolean } | null> {
    const byUrl = new Map((kept?.pages ?? []).map((p) => [p.url, p]));
    const pages: KeptPage[] = [];
    let tail = kept?.tail ?? null;
    let changed = kept === null;
    let url: string | null = firstPage(path);
    let probing = false;
    let lastLive = false;
    while (url !== null) {
      if (pages.length >= PAGE_CAP) {
        progress.overCap = true;
        return null;
      }
      const next = await step(url);
      if (next === "failed") return null;
      if (next === "done") break;
    }
    return done();

    async function step(at: string): Promise<"next" | "done" | "failed"> {
      const left = leftSec(ctx, startMs);
      const held = byUrl.get(at);
      const answer =
        left === 0 ? null : await readPage(at, validator(at), ctx, left);
      // A live last page already established that nothing follows it.
      if (answer === null) return probing && lastLive ? "done" : "failed";
      const fresh = answer.status === 200 ? answer : null;
      if (tailEnds(at, held, fresh)) return "done";
      const page = fresh
        ? { url: at, etag: fresh.etag, body: fresh.body, next: fresh.next }
        : held;
      if (page === undefined) return "failed";
      keepPage(page, fresh !== null);
      return advance(page);
    }

    function validator(at: string): string | null {
      const tailEtag = probing && tail?.url === at ? tail.etag : null;
      return (byUrl.get(at)?.etag ?? tailEtag) || null;
    }

    // The empty tail has no items to append, but its validator must be kept.
    function tailEnds(
      at: string,
      held: KeptPage | undefined,
      fresh: LiveAnswer | null,
    ): boolean {
      if (!probing) return false;
      if (fresh === null) return held === undefined;
      if (pageItems(fresh.body) !== 0) return false;
      if (tail?.url !== at || tail.etag !== fresh.etag) changed = true;
      tail = { url: at, etag: fresh.etag };
      return true;
    }

    function keepPage(page: KeptPage, live: boolean): void {
      changed ||= live;
      if (pages.length === 0 || (pageItems(page.body) ?? 0) > 0)
        pages.push(page);
      progress.pages = pages.length;
      probing = false;
      lastLive = live;
    }

    function advance(page: KeptPage): "next" | "done" | "failed" {
      if (page.next !== null) {
        url = page.next;
        return "next";
      }
      // At the cap, only a live terminal response proves nothing was appended
      // after a cached final page. A cached terminal link must fail closed so
      // the whole read can discover a new page beyond the cap.
      if (pages.length >= PAGE_CAP) return lastLive ? "done" : "failed";
      const after = followingPage(page.url);
      const known =
        after === null
          ? null
          : (byUrl.get(after)?.etag ??
            (tail?.url === after ? tail.etag : null));
      // A live last page needs the probe only to keep the tail validator.
      if (lastLive && (after === null || known !== null)) return "done";
      if (after === null) return "failed";
      url = after;
      probing = true;
      return "next";
    }

    function done() {
      return {
        entry: {
          acquiredAt: kept?.acquiredAt ?? startMs,
          pages,
          tail,
        },
        changed,
      };
    }
  }

  /**
   * The caller's own read, as it ran before: every page, no `If-None-Match`.
   * A failure counts the pages the walk before it got through, when those
   * are more than this read reached.
   */
  async function wholeRead(
    path: string,
    ctx: ObservedOptions,
    startMs: number,
    walked = 0,
  ): Promise<ObservedRun> {
    const left = leftSec(ctx, startMs);
    if (left === 0) return spent(path, walked > 0 ? walked : undefined);
    const opts = definedFields({
      cwd: ctx.cwd,
      env: ctx.env,
      stderr: ctx.stderr,
      timeoutSec: left,
      pagedWholeSec:
        left !== undefined && left > deps.defaultTimeoutSec()
          ? left
          : undefined,
    });
    const args = ["api", "--paginate", "--slurp", path];
    const result =
      Object.keys(opts).length === 0
        ? await ghCall(args)
        : await ghCall(args, opts);
    return result.code === 0 || walked <= (result.pagesRead ?? 0)
      ? result
      : { ...result, pagesRead: walked };
  }

  async function read(
    path: string,
    ctx: ObservedOptions,
    knownScope?: string | null,
    startMs = currentMs(),
    progress?: WalkProgress,
  ): Promise<ObservedRun> {
    const observedProgress = progress ?? { pages: 0, overCap: false };
    const dir = deps.cacheDir();
    const scope =
      knownScope === undefined ? await deps.repoScope(ctx) : knownScope;
    if (dir === null || scope === null) return wholeRead(path, ctx, startMs);
    const request = `pages ${path}`;
    const file = entryFile(dir, scope, request);
    const kept = readEntry(file, request);
    const walked = await walk(path, kept, ctx, startMs, observedProgress);
    // Past the cap the forge client refuses the whole read too, after sending
    // every page again; a `gh` paging for itself has no cap and may finish.
    if (walked === null && observedProgress.overCap && forgeBudgetOn(ctx.env))
      return overCap(path);
    if (walked === null)
      return wholeRead(path, ctx, startMs, observedProgress.pages);
    const { entry, changed } = walked;
    if (changed)
      writeJsonFile(dir, file, { v: ENTRY_VERSION, request, ...entry });
    else touch(file);
    return ok(
      `[${entry.pages
        .map((p) => p.body.trim())
        .filter((b) => b !== "")
        .join(",")}]`,
    );
  }

  /**
   * `gh api --paginate --slurp <path>`'s answer, read as an observation (see
   * the module comment): shared within the current evaluation, revalidated
   * page by page across evaluations, read whole whenever that cannot be
   * trusted.
   */
  async function ghObservedSlurp(
    path: string,
    ctx: ObservedOptions = {},
  ): Promise<ObservedRun> {
    ctx = { ...ctx, timeoutSec: ctx.timeoutSec ?? deps.defaultTimeoutSec() };
    const reads = evaluation.getStore();
    if (reads === undefined) return read(path, ctx);
    const startMs = currentMs();
    const remaining = leftSec(ctx, startMs);
    const scopeCtx =
      remaining === undefined ? ctx : { ...ctx, timeoutSec: remaining };
    const scope = await deps.repoScope(scopeCtx);
    if (scope === null) return read(path, ctx, scope, startMs);
    const key = memoKey(path, scope);
    const progress: WalkProgress = { pages: 0, overCap: false };
    const shared = coalesce(reads, key, async () => {
      const answer = await read(path, ctx, scope, startMs, progress);
      if (answer.code !== 0) reads.delete(key);
      return answer;
    });
    const own = !walks.has(shared);
    if (own) walks.set(shared, progress);
    return withinBudget(
      shared,
      path,
      ctx,
      startMs,
      own ? OWN_READ_GRACE_MS : 0,
    );
  }

  return { ghObservedSlurp };
}

/**
 * What a reading is shared under within one evaluation: the resolved repository
 * scope (which includes the credential) and path.
 */
function memoKey(path: string, scope: string): string {
  return createHash("sha256")
    .update([scope, path].join("\n--\n"))
    .digest("hex");
}

/** A shared reading, waited on no longer than this caller's own budget. */
function withinBudget(
  shared: Promise<ObservedRun>,
  path: string,
  ctx: ObservedOptions,
  startMs: number,
  graceMs: number,
): Promise<ObservedRun> {
  const budgetSec = ctx.timeoutSec;
  if (budgetSec === undefined) return shared.then((r) => ({ ...r }));
  const remainingMs = budgetSec * 1000 - (currentMs() - startMs);
  const pagesSoFar = () => walks.get(shared)?.pages || undefined;
  if (remainingMs <= 0) return Promise.resolve(spent(path, pagesSoFar()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ObservedRun>((done) => {
    timer = setTimeout(
      () => done(spent(path, pagesSoFar())),
      remainingMs + graceMs,
    );
  });
  return Promise.race([shared.then((r) => ({ ...r })), late]).finally(() =>
    clearTimeout(timer),
  );
}

/** Mark a kept entry used, so pruning drops the entries nobody revalidates first. */
function touch(file: string): void {
  touchFile(file);
}
