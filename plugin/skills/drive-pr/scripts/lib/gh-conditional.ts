/**
 * Cheap reads for polling loops.
 *
 * GitHub's GraphQL bucket is 5,000 points/hour per token, and every `gh pr
 * view` / `gh pr checks` / `gh repo view` spends from it. A polling loop pays
 * that cost on every tick whether or not anything changed, and one token backs
 * every driver, worktree and agent on the machine — so a handful of parallel
 * drives exhaust it (measured: ~4,200 points/hour against a 5,000 bucket).
 *
 * The tools below are all additive to the GraphQL reads they sit beside:
 *
 *   `ghConditionalGet`   REST GET with a persisted ETag. GitHub answers an
 *                        unchanged resource `304 Not Modified`, which does not
 *                        count against the primary rate limit — so polling an
 *                        idle PR is free after the first read.
 *   `readPrLiveness`     PR state + head SHA over that REST read. The mapping is
 *                        trivial (open/closed/merged), which is why it can
 *                        replace `gh pr view --json state,headRefOid` outright.
 *   `checkSignalsUnchanged`
 *                        A CHANGE DETECTOR for the checks a PR carries, not a
 *                        replacement for `gh pr checks`. The verdict stays with
 *                        `gh pr checks` (its bucket logic is not reimplemented
 *                        here on purpose: a REST misclassification would read as
 *                        a false convergence). The detector only lets a caller
 *                        skip re-asking while nothing has moved.
 *   `cachedRepoView`     Memoises the raw output of a successful `gh repo view`
 *                        across processes; owner/name never changes for a clone.
 *
 * Not a replacement for the field-rich reads (`mergeStateStatus`,
 * `baseRefOid`, review threads). REST and GraphQL disagree on mergeability and
 * on `baseRefOid`, and drive-pr's guards compare reads against each other, so
 * those stay GraphQL.
 *
 * `{owner}/{repo}` in a path is expanded by `gh` itself from the local remotes,
 * `$GH_REPO` and `gh repo set-default` — the same resolution `gh repo view`
 * performs, with no API call. The cache key therefore has to carry that
 * identity (`repoScope`), or two clones of different repositories would share
 * the literal string `{owner}/{repo}`.
 *
 * FAIL CLOSED. Every failure — an unreadable cache entry, an unparseable
 * response, a 304 with nothing cached — degrades to "no answer", which every
 * caller already treats as INDETERMINATE and retries. A cache problem can only
 * make a poll cost more, never make it wrong.
 *
 * A PARITY COPY: this file is byte-identical in the plugin's `shared/` and in
 * `drive-pr`'s `scripts/lib/`, each importing the `ghCall` beside it, which
 * must accept `timeoutSec` as a tightening, since `CallContext.timeoutSec` is
 * passed through it. `drive-pr/__tests__/gh-conditional-parity.test.ts` pins
 * the two together; `shared/__tests__/gh-conditional.test.ts` holds the
 * behavioural suite.
 *
 * Cache: `$JIG_GH_CACHE_DIR`, else `~/.cache/jig/gh-cache`. One small file
 * per (repo scope, request), overwritten in place, pruned to a bound — the
 * drive-pr state-dir lesson: an unbounded directory of tiny files is a
 * cost of its own. `JIG_GH_CACHE=off` disables it. Under `NODE_ENV=test`
 * (which `bun test` sets) it is off unless a directory is given explicitly, so
 * a suite that forgets to isolate itself runs uncached rather than reading a
 * neighbour's answer.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ghCall, git, type RunResult } from "./proc.ts";

/** Entries kept before pruning, and what pruning trims down to. */
const MAX_ENTRIES = 256;
const KEEP_ENTRIES = 128;
/** How long a cached `gh repo view` answer is trusted. The scope key already
 * invalidates on a remote / `set-default` / `$GH_REPO` change; this only bounds
 * an upstream rename that none of those can see. */
const REPO_VIEW_TTL_MS = 6 * 60 * 60 * 1000;
const ENTRY_VERSION = 1;
/** Deadline for each local `git` read in `repoScope`; it runs ahead of every
 * cached read, so a stalled probe must not stall the polling loop. */
const GIT_PROBE_TIMEOUT_SEC = 10;

/** The cache directory, or null when caching is off. */
export function ghCacheDir(): string | null {
  if ((process.env.JIG_GH_CACHE ?? "") === "off") return null;
  const explicit = process.env.JIG_GH_CACHE_DIR ?? "";
  if (explicit !== "") return explicit;
  if (process.env.NODE_ENV === "test") return null;
  const home = process.env.HOME || homedir();
  if (!home) return null;
  return join(home, ".cache", "jig", "gh-cache");
}

/** Where a `gh` call will run: the same `cwd`/`env` the call itself gets. */
export interface CallContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Whole seconds this read may spend in total: the local `git` reads that
   * resolve the scope AND the API call share it, so a caller that owns a
   * wall-clock budget (drive-status's `--timeout`) is not handed a read that
   * can outlive it. Once it is spent no further stage starts (the read fails
   * closed); a stage already running is bounded by what was left when it began,
   * rounded up to whole seconds. Omitted: only the per-call defaults apply.
   */
  timeoutSec?: number;
  /**
   * Which read this is, sent as an `X-Drive-Pr-Caller` request header. GitHub
   * ignores it; it exists so a test double for `gh` can tell two callers of the
   * same endpoint apart by their argv instead of inferring it from call order
   * or timing, which no fixture can make sound (a poll that returns early
   * leaves no trace of which read came next). Not part of the cache identity.
   */
  caller?: string;
}

/** Whole seconds left of `ctx.timeoutSec` at `startMs`; 0 once it is spent
 * (callers stop rather than start another stage), undefined when the caller set
 * no budget. Not floored: a floor of one second would let every later stage
 * start a fresh one-second operation and outlive the budget. */
function budgetLeftSec(ctx: CallContext, startMs: number): number | undefined {
  if (ctx.timeoutSec === undefined) return undefined;
  return Math.max(0, Math.ceil(ctx.timeoutSec - (Date.now() - startMs) / 1000));
}

/**
 * What `{owner}/{repo}` means for a call run in `ctx`, as a digest — or null
 * when it cannot be established (not a git checkout), in which case nothing is
 * cached. The inputs are exactly what `gh` resolves the placeholder from, read
 * from the SAME `cwd`/`env` the `gh` call will receive: a caller that anchors
 * `gh` at another checkout, or strips `GH_REPO` (drive-pr's `ghRepoEnv()`, so
 * the answer is about the repository AT `cwd`), must get that repository's
 * identity, never the ambient one.
 */
function repoScope(ctx: CallContext = {}): Promise<string | null> {
  const env = ctx.env ?? process.env;
  // Deliberately NOT memoised: the remotes and `gh-resolved` config are what
  // `gh` resolves `{owner}/{repo}` from on every call, and they can change (or
  // the process can `chdir`) under a long-lived driver. Two local `git` reads
  // per poll are free next to the API read they guard.
  return (async () => {
    const startMs = Date.now();
    // Each probe is bounded by its own default AND by what is left of the
    // caller's budget, so two stalled reads cannot spend it twice over.
    const opts = () => ({
      stderr: "ignore" as const,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutSec: Math.min(
        GIT_PROBE_TIMEOUT_SEC,
        budgetLeftSec(ctx, startMs) ?? GIT_PROBE_TIMEOUT_SEC,
      ),
    });
    // A spent budget means the scope is unknown, not that another probe may run.
    if (budgetLeftSec(ctx, startMs) === 0) return null;
    const remotes = await git(["remote", "-v"], opts());
    if (remotes.code !== 0) return null;
    // A remote-less checkout is still identified when GH_REPO names the
    // repository `gh` will resolve `{owner}/{repo}` to.
    if (remotes.stdout.trim() === "" && !env.GH_REPO) return null;
    // `gh repo set-default` persists here; exit 1 with no output = none set.
    if (budgetLeftSec(ctx, startMs) === 0) return null;
    const resolved = await git(
      ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
      opts(),
    );
    // Exit 1 with no output is git's "no such key" (no default set). Any other
    // failure (timeout, unreadable config) is unknown, not "none": hashing its
    // empty stdout would alias a real default's scope to the no-default one.
    if (
      resolved.code !== 0 &&
      !(resolved.code === 1 && resolved.stdout === "")
    ) {
      return null;
    }
    return createHash("sha256")
      .update(
        [
          env.GH_HOST ?? "",
          env.GH_REPO ?? "",
          remotes.stdout,
          resolved.stdout,
        ].join("\n--\n"),
      )
      .digest("hex");
  })();
}

function entryFile(dir: string, scope: string, request: string): string {
  const key = createHash("sha256")
    .update(`${scope}\n${request}`)
    .digest("hex")
    .slice(0, 40);
  return join(dir, `${key}.json`);
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJsonFile(dir: string, file: string, value: unknown): void {
  try {
    // Entries hold PR documents: owner-only, whatever the umask says.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
    prune(dir);
  } catch {
    // Best-effort: a cache that cannot be written costs a re-read, no more.
  }
}

function prune(dir: string): void {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (names.length <= MAX_ENTRIES) return;
  const aged = names
    .map((n) => {
      try {
        return { n, t: statSync(join(dir, n)).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - KEEP_ENTRIES)) {
    rmSync(join(dir, n), { force: true });
  }
}

export type ConditionalGet =
  | { ok: true; changed: boolean; body: string }
  | { ok: false; reason: string };

interface ParsedResponse {
  status: number;
  etag: string;
  body: string;
}

/** Split `gh api -i` output: status line, headers, blank line, body. */
function parseResponse(out: string): ParsedResponse | null {
  const gap = /\r?\n\r?\n/.exec(out);
  const head = gap ? out.slice(0, gap.index) : out;
  const body = gap ? out.slice(gap.index + gap[0].length) : "";
  const lines = head.split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? "");
  if (!status) return null;
  let etag = "";
  for (const line of lines.slice(1)) {
    const m = /^etag:\s*(.+)$/i.exec(line);
    if (m) etag = (m[1] ?? "").trim();
  }
  return { status: Number.parseInt(status[1] ?? "0", 10), etag, body };
}

/**
 * GET a REST `path` (a `gh api` endpoint; `{owner}`/`{repo}` are expanded by
 * `gh`). `changed: false` means GitHub confirmed the cached body is current.
 */
export function ghConditionalGet(
  path: string,
  ctx: CallContext = {},
): Promise<ConditionalGet> {
  return conditional(path, ctx, true);
}

/**
 * Change detection only: like `ghConditionalGet`, but the response body is
 * NEVER kept on disk (an ETag alone answers "did it change?"), and `body` is ''
 * on a 304. For endpoints whose documents are large and whose contents the
 * caller does not read — the check-runs listing runs to hundreds of KB. Entries
 * live in their own namespace, so a caller that needs the body can never be
 * handed a body-less entry.
 */
export function ghConditionalProbe(
  path: string,
  ctx: CallContext = {},
): Promise<ConditionalGet> {
  return conditional(path, ctx, false);
}

/**
 * Change-detection ETags (`ghConditionalProbe`) live in THIS process only. A
 * probe answers "did it change since THIS caller last looked?", and a caller's
 * baseline is the verdict it read itself: through the shared disk cache another
 * process's ETag write would turn this caller's next 304 into a false "still
 * the verdict I hold". Keyed like the disk
 * entries, so caching off / an unresolvable scope still means "no baseline".
 */
const probeBaselines = new Map<string, string>();

/** Test seam: forget every in-process probe baseline. */
export function resetProbeBaselines(): void {
  probeBaselines.clear();
}

async function conditional(
  path: string,
  ctx: CallContext,
  keepBody: boolean,
): Promise<ConditionalGet> {
  const startMs = Date.now();
  // Distinct request identity per mode: the entry key AND the in-entry guard.
  const request = keepBody ? path : `etag-only ${path}`;
  const dir = ghCacheDir();
  const scope = dir === null ? null : await repoScope(ctx);
  const file =
    dir !== null && scope !== null ? entryFile(dir, scope, request) : null;

  let cached: { etag: string; body: string } | null = null;
  if (file !== null && !keepBody) {
    const etag = probeBaselines.get(file);
    if (etag !== undefined) cached = { etag, body: "" };
  } else if (file !== null) {
    const e = readJsonFile(file);
    if (
      e !== null &&
      e.v === ENTRY_VERSION &&
      e.path === request &&
      typeof e.etag === "string" &&
      e.etag !== "" &&
      typeof e.body === "string"
    ) {
      cached = { etag: e.etag, body: e.body };
    }
  }

  const left = budgetLeftSec(ctx, startMs);
  if (left === 0) {
    return { ok: false, reason: `gh api ${path}: caller budget exhausted` };
  }
  const r = await ghCall(
    [
      "api",
      "-i",
      ...(cached ? ["-H", `If-None-Match: ${cached.etag}`] : []),
      ...(ctx.caller ? ["-H", `X-Drive-Pr-Caller: ${ctx.caller}`] : []),
      path,
    ],
    { cwd: ctx.cwd, env: ctx.env, timeoutSec: left },
  );
  if (r.timedOut) return { ok: false, reason: `gh api ${path} timed out` };
  if (r.bufferExceeded) {
    return { ok: false, reason: `gh api ${path} output exceeded the buffer` };
  }
  const parsed = parseResponse(r.stdout);
  if (parsed === null) {
    return {
      ok: false,
      reason: `gh api ${path}: unparseable response (exit ${r.code})`,
    };
  }
  // `gh api` exits 1 on a 304 ("gh: HTTP 304"), so the status line — not the
  // exit code — is what decides. Order matters: this must precede the 2xx
  // check's `code === 0` requirement.
  if (parsed.status === 304) {
    return cached
      ? { ok: true, changed: false, body: cached.body }
      : { ok: false, reason: `gh api ${path}: 304 with nothing cached` };
  }
  if (parsed.status >= 200 && parsed.status < 300 && r.code === 0) {
    if (file !== null && !keepBody) {
      if (parsed.etag !== "") probeBaselines.set(file, parsed.etag);
      else probeBaselines.delete(file);
    } else if (file !== null && dir !== null && parsed.etag !== "") {
      writeJsonFile(dir, file, {
        v: ENTRY_VERSION,
        path: request,
        etag: parsed.etag,
        body: parsed.body,
      });
    }
    return { ok: true, changed: true, body: parsed.body };
  }
  return {
    ok: false,
    reason: `gh api ${path}: HTTP ${parsed.status} (exit ${r.code})`,
  };
}

export type PrLiveness =
  | { ok: true; state: "OPEN" | "CLOSED" | "MERGED"; head: string }
  | { ok: false; reason: string };

/**
 * A PR's state and head SHA — the values `gh pr view --json
 * state,headRefOid` reports, over a conditional REST read. `head` is '' when
 * GitHub's document carries no usable SHA. Only for a numeric PR: a URL or
 * branch argument has no REST path here and stays with `gh pr view`.
 */
export async function readPrLiveness(
  pr: string,
  ctx: CallContext = {},
): Promise<PrLiveness> {
  if (!/^\d+$/.test(pr)) return { ok: false, reason: "PR is not a number" };
  const r = await ghConditionalGet(`repos/{owner}/{repo}/pulls/${pr}`, ctx);
  if (!r.ok) return r;
  let j: {
    state?: unknown;
    merged?: unknown;
    head?: { sha?: unknown } | null;
  };
  try {
    const parsed: unknown = JSON.parse(r.body);
    // `null`, an array or a scalar is valid JSON but not a pull document.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, reason: `pulls/${pr}: response is not an object` };
    }
    j = parsed as typeof j;
  } catch {
    return { ok: false, reason: `pulls/${pr}: unparseable JSON` };
  }
  // An absent or malformed head is reported as '' rather than failing the read:
  // state and head were independent reads before, callers that need the head
  // already treat '' as "cannot resolve it" (a round is not counted, the checks
  // gate does not run), and a state that IS readable should not be discarded
  // because a field beside it is not.
  const sha = j.head?.sha;
  const head =
    typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha) ? sha : "";
  // `merged` only refines a recognised state: a document with no readable
  // `state` is not a pull document we can vouch for, merged flag or not.
  if (j.state !== "open" && j.state !== "closed") {
    return { ok: false, reason: `pulls/${pr}: unrecognised state` };
  }
  if (j.merged === true) return { ok: true, state: "MERGED", head };
  return { ok: true, state: j.state === "open" ? "OPEN" : "CLOSED", head };
}

/**
 * `true` ONLY when GitHub confirmed that neither the check runs nor the
 * commit statuses on `sha` changed since this same cache last read them.
 * Anything else — a change, an error, caching off, a first read — is `false`,
 * i.e. "go and read authoritatively". Both endpoints are always queried so
 * both ETags stay fresh.
 *
 * A change detector, not a source of truth: pages beyond the first hundred
 * runs are not watched, which is why the caller must still bound how long it
 * trusts an unchanged answer.
 */
export async function checkSignalsUnchanged(sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
  const [runs, statuses] = await Promise.all([
    ghConditionalProbe(
      `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`,
    ),
    ghConditionalProbe(`repos/{owner}/{repo}/commits/${sha}/status`),
  ]);
  return runs.ok && !runs.changed && statuses.ok && !statuses.changed;
}

/**
 * `gh repo view <args>`, answered from a cross-process cache when a previous
 * call with the SAME arguments succeeded for the same repository scope. Returns
 * the same `RunResult` a direct call would, so callers keep their own parsing
 * and error handling. Only a successful answer is ever cached.
 */
export async function cachedRepoView(
  args: string[],
  opts: CallContext & { stderr?: "pipe" | "inherit" | "ignore" } = {},
): Promise<RunResult> {
  const startMs = Date.now();
  const dir = ghCacheDir();
  const scope = dir === null ? null : await repoScope(opts);
  const request = `repo view ${JSON.stringify(args)}`;
  const file =
    dir !== null && scope !== null ? entryFile(dir, scope, request) : null;

  if (file !== null) {
    const e = readJsonFile(file);
    if (
      e !== null &&
      e.v === ENTRY_VERSION &&
      e.request === request &&
      typeof e.stdout === "string" &&
      e.stdout.trim() !== "" &&
      typeof e.at === "number" &&
      Date.now() - e.at < REPO_VIEW_TTL_MS
    ) {
      const hit: RunResult = {
        code: 0,
        stdout: e.stdout,
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "",
      };
      return hit;
    }
  }

  // The scope probes above spent part of the caller's budget; the call gets
  // only what is left, and none at all once it is gone (fail closed, like
  // `conditional`).
  const left = budgetLeftSec(opts, startMs);
  if (left === 0) {
    return {
      code: 1,
      stdout: "",
      stderr: "gh repo view: caller budget exhausted",
      timedOut: true,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "gh repo view: caller budget exhausted",
    };
  }
  const r = await ghCall(["repo", "view", ...args], {
    ...opts,
    timeoutSec: left,
  });
  if (
    file !== null &&
    dir !== null &&
    r.code === 0 &&
    !r.timedOut &&
    r.stdout.trim() !== ""
  ) {
    writeJsonFile(dir, file, {
      v: ENTRY_VERSION,
      request,
      stdout: r.stdout,
      at: Date.now(),
    });
  }
  return r;
}
