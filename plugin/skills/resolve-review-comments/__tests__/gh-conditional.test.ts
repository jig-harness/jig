/**
 * `lib/gh-conditional.ts` — conditional REST reads and the
 * cross-process `gh repo view` cache.
 *
 * Shell-backed HTTP fixture groups run on macOS/Linux; pure cache tests and
 * bundled installation tests run on all three native platforms. Production
 * commands use argv spawning and do not require Bash.
 *
 * In-process, against a stub `gh` that emulates GitHub's ETag behaviour: a
 * request carrying `If-None-Match: <current etag>` gets `304` and exit 1 (as
 * the real CLI does — `gh: HTTP 304`), anything else gets the body and an ETag
 * derived from it, and every invocation is appended to `calls.log` so a test
 * can read off what actually went over the wire rather than infer it.
 *
 * The cache directory is always set explicitly: under `bun test`
 * (`NODE_ENV=test`) the helper is uncached unless one is given, so no test in
 * this repo can read a neighbour's answer by accident.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import type { SpawnSyncOptions } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedRepoView,
  checkSignalsUnchanged,
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
  readPrLiveness,
  resetProbeBaselines,
} from "../scripts/lib/gh-conditional.ts";

function runScratch(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
): string {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Scratch command failed: ${result.stderr}`);
  return result.stdout;
}

const SHA = "a".repeat(40);
const SHA_2 = "b".repeat(40);

const STUB = `#!/usr/bin/env bash
D="\${GH_STUB_DIR:?GH_STUB_DIR not set}"
echo "$*" >> "$D/calls.log"
if [ "$1 $2" = 'api -i' ]; then
  shift 2
  inm=''
  while [ "$#" -gt 1 ]; do
    if [ "$1" = '-H' ]; then inm="\${2#If-None-Match: }"; shift 2; else shift; fi
  done
  path="$1"
  key=$(printf '%s' "$path" | tr -c 'A-Za-z0-9' '_')
  # A stalled API: sleeps this many seconds before answering, so a deadline
  # (not the answer) is what ends the call.
  [ -f "$D/hang" ] && sleep "$(cat "$D/hang")"
  status=200
  [ -f "$D/resp/$key.status" ] && status=$(cat "$D/resp/$key.status")
  if [ "$status" != 200 ]; then
    printf 'HTTP/2.0 %s Error\\r\\n\\r\\n{"message":"stub"}' "$status"
    echo "gh: HTTP $status" >&2
    exit 1
  fi
  if [ -f "$D/resp/$key.always304" ]; then
    printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: W/"x"\\r\\n\\r\\n'
    echo 'gh: HTTP 304' >&2
    exit 1
  fi
  [ -f "$D/resp/$key.body" ] || { echo "gh-stub: no fixture for $path" >&2; exit 2; }
  etag=$(cksum < "$D/resp/$key.body" | tr ' ' '-')
  if [ -n "$inm" ] && [ "$inm" = "$etag" ]; then
    printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: %s\\r\\n\\r\\n' "$etag"
    echo 'gh: HTTP 304' >&2
    exit 1
  fi
  printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nEtag: %s\\r\\n\\r\\n' "$etag"
  cat "$D/resp/$key.body"
  exit 0
fi
if [ "$1 $2" = 'repo view' ]; then
  # A failure that STILL wrote something to stdout: the shape that separates
  # "the exit code was checked" from "the output happened to be empty".
  [ -f "$D/repo-view-fail-noisy" ] && { echo 'partial garbage'; echo 'gh: repo view failed' >&2; exit 1; }
  [ -f "$D/repo-view-fail" ] && { echo 'gh: repo view failed' >&2; exit 1; }
  cat "$D/repo-view.$(basename "$PWD").out"
  exit 0
fi
echo "gh-stub: unhandled: $*" >&2
exit 2
`;

let tmpRoot: string;
let binDir: string;
let fixDir: string;
let cacheDir: string;
let repoA: string;
let repoB: string;
let savedCwd: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "NODE_ENV",
  "HOME",
  "PATH",
  "GH_STUB_DIR",
  "JIG_GH_CACHE_DIR",
  "JIG_GH_CACHE",
  "GH_REPO",
  "GH_HOST",
  "GH_CALL_TIMEOUT",
];

function initRepo(name: string, origin: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir);
  const git = (...a: string[]) =>
    runScratch("git", a, {
      cwd: dir,
      encoding: "utf8",
      // A dev shell inside a hook or drive exports GIT_DIR and friends, which
      // would redirect these setup calls into the real repository.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
      ) as Record<string, string>,
    });
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  return dir;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "gh-conditional-"));
  binDir = join(tmpRoot, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "gh"), STUB);
  chmodSync(join(binDir, "gh"), 0o755);
  repoA = initRepo("repo-a", "git@github.com:acme/widgets.git");
  repoB = initRepo("repo-b", "git@github.com:acme/gadgets.git");
  savedCwd = process.cwd();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  process.chdir(savedCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
beforeEach(() => {
  resetProbeBaselines();
  fixDir = join(tmpRoot, `fix-${++seq}`);
  mkdirSync(join(fixDir, "resp"), { recursive: true });
  cacheDir = join(tmpRoot, `cache-${seq}`);
  process.env.PATH = `${binDir}:${savedEnv.PATH}`;
  process.env.GH_STUB_DIR = fixDir;
  process.env.JIG_GH_CACHE_DIR = cacheDir;
  process.env.GH_CALL_TIMEOUT = "20";
  delete process.env.JIG_GH_CACHE;
  delete process.env.GH_REPO;
  delete process.env.GH_HOST;
  process.chdir(repoA);
});

afterEach(() => {
  process.chdir(savedCwd);
});

const keyOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, "_");

function serve(path: string, body: unknown): void {
  writeFileSync(
    join(fixDir, "resp", `${keyOf(path)}.body`),
    JSON.stringify(body),
  );
  rmSync(join(fixDir, "resp", `${keyOf(path)}.status`), { force: true });
}

function failWith(path: string, status: number): void {
  writeFileSync(join(fixDir, "resp", `${keyOf(path)}.status`), String(status));
}

const calls = (): string[] =>
  existsSync(join(fixDir, "calls.log"))
    ? readFileSync(join(fixDir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
    : [];

const conditionalCalls = () =>
  calls().filter((c) => c.includes("If-None-Match"));

const entryFiles = (): string[] =>
  existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((n) => n.endsWith(".json"))
    : [];

const PULL = "repos/{owner}/{repo}/pulls/7";

function pull(state: "open" | "closed", merged: boolean, sha: string | null) {
  return {
    state,
    merged,
    ...(sha === null ? {} : { head: { sha } }),
  };
}

describe.skipIf(process.platform === "win32")("ghConditionalGet", () => {
  it("reads unconditionally first, then revalidates and reuses the cached body on 304", async () => {
    serve(PULL, pull("open", false, SHA));
    const first = await ghConditionalGet(PULL);
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(conditionalCalls()).toHaveLength(0);

    const second = await ghConditionalGet(PULL);
    // The 304 arrives with exit 1 from the real CLI; it is a hit, not a failure.
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(second.ok && second.body).toBe(first.ok ? first.body : "x");
    expect(conditionalCalls()).toHaveLength(1);
  });

  it("returns the new body and re-arms the ETag when the resource changed", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    serve(PULL, pull("open", false, SHA_2));

    const changed = await ghConditionalGet(PULL);
    expect(changed).toMatchObject({ ok: true, changed: true });
    expect(changed.ok && changed.body).toContain(SHA_2);

    // …and the NEXT read revalidates against the new ETag, not the stale one.
    expect(await ghConditionalGet(PULL)).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it("fails on a non-2xx, non-304 status and never caches it", async () => {
    failWith(PULL, 404);
    const r = await ghConditionalGet(PULL);
    expect(r.ok).toBe(false);
    expect(entryFiles()).toHaveLength(0);
  });

  it("treats a corrupt cache entry as a miss and reads unconditionally", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    const [entry] = entryFiles();
    writeFileSync(join(cacheDir, entry ?? ""), "{not json");

    const r = await ghConditionalGet(PULL);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(conditionalCalls()).toHaveLength(0);
  });

  it("ignores an entry recorded for a different request (key collision guard)", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    const [entry] = entryFiles();
    const file = join(cacheDir, entry ?? "");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.path = "repos/{owner}/{repo}/pulls/8";
    writeFileSync(file, JSON.stringify(doc));

    await ghConditionalGet(PULL);
    expect(conditionalCalls()).toHaveLength(0);
  });

  it("fails closed when GitHub answers 304 but nothing is cached", async () => {
    // A 304 is only meaningful against an ETag we sent. Answering one to an
    // unconditional request means there is no body to fall back to — that must
    // read as "no answer", never as an empty resource.
    writeFileSync(join(fixDir, "resp", `${keyOf(PULL)}.always304`), "");
    const r = await ghConditionalGet(PULL);
    expect(r.ok).toBe(false);
    expect(conditionalCalls()).toHaveLength(0);
  });

  it("treats an entry whose body is missing as a miss (a partial write is not a hit)", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    const [entry] = entryFiles();
    const file = join(cacheDir, entry ?? "");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    delete doc.body;
    writeFileSync(file, JSON.stringify(doc));

    const r = await ghConditionalGet(PULL);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(conditionalCalls()).toHaveLength(0);
  });

  it("never sends a conditional request when no cache directory is configured", async () => {
    delete process.env.JIG_GH_CACHE_DIR; // NODE_ENV=test ⇒ off
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    const again = await ghConditionalGet(PULL);
    expect(again).toMatchObject({ ok: true, changed: true });
    expect(conditionalCalls()).toHaveLength(0);
    expect(entryFiles()).toHaveLength(0);
  });

  it("JIG_GH_CACHE=off wins over an explicit directory", async () => {
    process.env.JIG_GH_CACHE = "off";
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    await ghConditionalGet(PULL);
    expect(conditionalCalls()).toHaveLength(0);
    expect(entryFiles()).toHaveLength(0);
  });

  it("does not share entries between repositories that both spell the path {owner}/{repo}", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);

    process.chdir(repoB);
    await ghConditionalGet(PULL);
    // Repo B has no entry of its own yet, so its first read is unconditional
    // even though repo A's entry for the identical literal path exists.
    expect(conditionalCalls()).toHaveLength(0);
    expect(entryFiles()).toHaveLength(2);
  });

  it("re-derives the scope when the remotes change within one process", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    process.chdir(repoB);
    await ghConditionalGet(PULL);
    process.chdir(repoA);
    await ghConditionalGet(PULL);
    // Back in repo A the entry from the first read is found again: one
    // conditional request, not a scope frozen to whichever repo ran first.
    expect(conditionalCalls()).toHaveLength(1);
  });

  it("keeps the cache directory and entries owner-only", async () => {
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    expect(statSync(cacheDir).mode & 0o077).toBe(0);
    for (const f of entryFiles()) {
      expect(statSync(join(cacheDir, f)).mode & 0o077).toBe(0);
    }
  });

  it("prunes the oldest entries once the directory outgrows its bound", async () => {
    mkdirSync(cacheDir, { recursive: true });
    const fakes = 300;
    for (let i = 0; i < fakes; i++) {
      const f = join(cacheDir, `fake-${String(i).padStart(3, "0")}.json`);
      writeFileSync(f, "{}");
      utimesSync(f, 1_000 + i, 1_000 + i);
    }
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);

    const left = entryFiles();
    // 300 fakes + the fresh entry = 301 > MAX_ENTRIES (256): pruned to KEEP_ENTRIES (128).
    expect(left.length).toBeLessThanOrEqual(128);
    expect(left).not.toContain("fake-000.json"); // oldest went first
    expect(left).toContain(`fake-${fakes - 1}.json`); // newest fake survives
    // …and the entry just written is never the one pruned.
    serve(PULL, pull("open", false, SHA));
    await ghConditionalGet(PULL);
    expect(conditionalCalls()).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("ghConditionalProbe", () => {
  const BIG = "repos/{owner}/{repo}/commits/x/check-runs?per_page=100";

  it("revalidates like a conditional GET but never keeps the body on disk", async () => {
    const payload = {
      total_count: 1,
      check_runs: [{ name: "x".repeat(5000) }],
    };
    serve(BIG, payload);
    expect(await ghConditionalProbe(BIG)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await ghConditionalProbe(BIG)).toMatchObject({
      ok: true,
      changed: false,
      body: "",
    });
    expect(conditionalCalls()).toHaveLength(1);
    for (const f of entryFiles()) {
      expect(readFileSync(join(cacheDir, f), "utf8")).not.toContain("xxxxx");
    }
  });

  // The baseline is the verdict THIS poller read: a shared on-disk ETag would
  // let another process's write turn our next 304 into a false "unchanged".
  it("keeps its baseline in-process, so another process cannot advance it", async () => {
    serve(BIG, { total_count: 1 });
    await ghConditionalProbe(BIG);
    expect(entryFiles()).toHaveLength(0);
    resetProbeBaselines(); // a fresh process has no baseline of ours
    expect(await ghConditionalProbe(BIG)).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it("still reports a change when the resource moves", async () => {
    serve(BIG, { total_count: 1 });
    await ghConditionalProbe(BIG);
    serve(BIG, { total_count: 2 });
    expect(await ghConditionalProbe(BIG)).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  // A body-less entry served to a caller that needs the body would return ''
  // as if it were the document. Separate namespaces make that unreachable.
  it("never hands its body-less entry to a caller that needs the body", async () => {
    serve(BIG, { total_count: 3 });
    await ghConditionalProbe(BIG);
    const got = await ghConditionalGet(BIG);
    expect(got).toMatchObject({ ok: true, changed: true }); // unconditional read
    expect(got.ok && got.body).toContain('"total_count":3');
    expect(conditionalCalls()).toHaveLength(0);
  });
});

describe.skipIf(process.platform === "win32")("readPrLiveness", () => {
  it.each([
    ["open", false, "OPEN"],
    ["closed", false, "CLOSED"],
    ["closed", true, "MERGED"],
  ] as const)("maps %s (merged=%s) to %s", async (state, merged, want) => {
    serve(PULL, pull(state, merged, SHA));
    expect(await readPrLiveness("7")).toEqual({
      ok: true,
      state: want,
      head: SHA,
    });
  });

  it("reports an empty head, not a failed read, when the head SHA is absent or malformed", async () => {
    serve(PULL, pull("open", false, null));
    expect(await readPrLiveness("7")).toEqual({
      ok: true,
      state: "OPEN",
      head: "",
    });
    serve(PULL, pull("open", false, "not-a-sha"));
    expect(await readPrLiveness("7")).toEqual({
      ok: true,
      state: "OPEN",
      head: "",
    });
  });

  it("fails closed on an unrecognised state instead of guessing", async () => {
    serve(PULL, { state: "draft?", merged: false, head: { sha: SHA } });
    expect((await readPrLiveness("7")).ok).toBe(false);
  });

  it("fails closed on a body that is not JSON", async () => {
    writeFileSync(join(fixDir, "resp", `${keyOf(PULL)}.body`), "nope");
    expect((await readPrLiveness("7")).ok).toBe(false);
  });

  it.each(["null", "[]", "7", '"open"'])(
    "fails closed on valid JSON that is not a pull document (%s)",
    async (body) => {
      writeFileSync(join(fixDir, "resp", `${keyOf(PULL)}.body`), body);
      expect((await readPrLiveness("7")).ok).toBe(false);
    },
  );

  it("refuses a non-numeric PR without calling gh (no REST path for a URL or branch)", async () => {
    expect((await readPrLiveness("feature/x")).ok).toBe(false);
    expect((await readPrLiveness("7; rm -rf")).ok).toBe(false);
    expect(calls()).toHaveLength(0);
  });

  it("is bounded by the caller's whole budget, so a stalled API cannot outlive it", async () => {
    // drive-status hands this the remainder of its own `--timeout`; the
    // default 20s `GH_CALL_TIMEOUT` set for this suite must NOT be what ends
    // the call.
    serve(PULL, { state: "open", head: { sha: SHA } });
    writeFileSync(join(fixDir, "hang"), "15");
    const t0 = Date.now();
    const r = await readPrLiveness("7", { timeoutSec: 1 });
    expect(r.ok).toBe(false);
    // Under the 5s a mis-applied fixed deadline would take.
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 20_000);

  it("starts no gh call once the caller budget is spent, instead of flooring it to a fresh second", async () => {
    serve(PULL, { state: "open", head: { sha: SHA } });
    const r = await readPrLiveness("7", { timeoutSec: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("budget exhausted");
    expect(calls()).toHaveLength(0);
  });

  it("surfaces a transport failure as not-ok", async () => {
    failWith(PULL, 500);
    expect((await readPrLiveness("7")).ok).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("checkSignalsUnchanged", () => {
  const RUNS = `repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100`;
  const STATUS = `repos/{owner}/{repo}/commits/${SHA}/status`;

  it("is false on the first read (nothing to compare against), then true once both are confirmed unchanged", async () => {
    serve(RUNS, { total_count: 1, check_runs: [{ name: "a" }] });
    serve(STATUS, { state: "pending", statuses: [] });
    expect(await checkSignalsUnchanged(SHA)).toBe(false);
    expect(await checkSignalsUnchanged(SHA)).toBe(true);
  });

  it("is false when the check runs change", async () => {
    serve(RUNS, { total_count: 1, check_runs: [{ name: "a" }] });
    serve(STATUS, { state: "pending", statuses: [] });
    await checkSignalsUnchanged(SHA);
    serve(RUNS, {
      total_count: 1,
      check_runs: [{ name: "a", status: "done" }],
    });
    expect(await checkSignalsUnchanged(SHA)).toBe(false);
  });

  // The conjunction's second clause, isolated: runs are UNCHANGED, so only the
  // statuses can be what flips the answer. A fixture that also moved the runs
  // would pass whether or not the statuses were consulted at all.
  it("is false when ONLY a commit status changes", async () => {
    serve(RUNS, { total_count: 1, check_runs: [{ name: "a" }] });
    serve(STATUS, { state: "pending", statuses: [] });
    await checkSignalsUnchanged(SHA);
    serve(STATUS, { state: "success", statuses: [{ context: "ci" }] });
    expect(await checkSignalsUnchanged(SHA)).toBe(false);
  });

  it("is false when either endpoint errors", async () => {
    serve(RUNS, { total_count: 0, check_runs: [] });
    failWith(STATUS, 500);
    expect(await checkSignalsUnchanged(SHA)).toBe(false);
    expect(await checkSignalsUnchanged(SHA)).toBe(false);
  });

  it("queries both endpoints every time so both ETags stay fresh", async () => {
    serve(RUNS, { total_count: 0, check_runs: [] });
    serve(STATUS, { state: "pending", statuses: [] });
    await checkSignalsUnchanged(SHA);
    // A change to the FIRST endpoint must not stop the second from being read:
    // if it short-circuited, the second ETag would go stale and the next call
    // would spuriously report a change.
    serve(RUNS, { total_count: 1, check_runs: [{ name: "a" }] });
    await checkSignalsUnchanged(SHA);
    const statusReads = calls().filter((c) => c.includes("/status"));
    expect(statusReads).toHaveLength(2);
  });

  it("refuses a malformed SHA without calling gh", async () => {
    expect(await checkSignalsUnchanged("not-a-sha")).toBe(false);
    expect(calls()).toHaveLength(0);
  });
});

describe.skipIf(process.platform === "win32")("cachedRepoView", () => {
  const ARGS = ["--json", "owner,name"];
  const out = (repo: string, text: string) =>
    writeFileSync(join(fixDir, `repo-view.${repo}.out`), text);

  beforeEach(() => {
    out("repo-a", "acme widgets\n");
    out("repo-b", "acme gadgets\n");
  });

  const viewCalls = () => calls().filter((c) => c.startsWith("repo view"));

  it("answers the second call from the cache without invoking gh", async () => {
    const first = await cachedRepoView(ARGS);
    const second = await cachedRepoView(ARGS);
    expect(first.stdout).toBe("acme widgets\n");
    expect(second).toMatchObject({ code: 0, stdout: "acme widgets\n" });
    expect(viewCalls()).toHaveLength(1);
  });

  it("keeps entries for different argument lists apart", async () => {
    await cachedRepoView(ARGS);
    await cachedRepoView([...ARGS, "-q", ".name"]);
    expect(viewCalls()).toHaveLength(2);
  });

  it("never caches a failure", async () => {
    writeFileSync(join(fixDir, "repo-view-fail"), "");
    expect((await cachedRepoView(ARGS)).code).toBe(1);
    rmSync(join(fixDir, "repo-view-fail"));
    expect((await cachedRepoView(ARGS)).code).toBe(0);
    expect(viewCalls()).toHaveLength(2);
  });

  it("never caches a failed call even when it printed something to stdout", async () => {
    writeFileSync(join(fixDir, "repo-view-fail-noisy"), "");
    const bad = await cachedRepoView(ARGS);
    expect(bad.code).toBe(1);
    rmSync(join(fixDir, "repo-view-fail-noisy"));
    // Served from gh again — not from a cached 'partial garbage'.
    const good = await cachedRepoView(ARGS);
    expect(good).toMatchObject({ code: 0, stdout: "acme widgets\n" });
    expect(viewCalls()).toHaveLength(2);
  });

  it("does not cache an empty answer", async () => {
    out("repo-a", "");
    await cachedRepoView(ARGS);
    out("repo-a", "acme widgets\n");
    const r = await cachedRepoView(ARGS);
    expect(r.stdout).toBe("acme widgets\n");
    expect(viewCalls()).toHaveLength(2);
  });

  // The regression that matters. drive-pr's origin-URL verification asks `gh`
  // about the repository AT a given cwd; an answer cached for the AMBIENT
  // checkout would let it verify one repository against another's identity.
  it("keys on the cwd the gh call runs in, never the ambient one", async () => {
    const a = await cachedRepoView(ARGS, { cwd: repoA });
    const b = await cachedRepoView(ARGS, { cwd: repoB });
    expect(a.stdout).toBe("acme widgets\n");
    expect(b.stdout).toBe("acme gadgets\n");
    // Both now cached: each is answered from ITS OWN entry.
    expect((await cachedRepoView(ARGS, { cwd: repoA })).stdout).toBe(
      "acme widgets\n",
    );
    expect((await cachedRepoView(ARGS, { cwd: repoB })).stdout).toBe(
      "acme gadgets\n",
    );
    expect(viewCalls()).toHaveLength(2);
  });

  it("keys on GH_REPO in the env the gh call receives", async () => {
    await cachedRepoView(ARGS, { cwd: repoA });
    // drive-pr's ghRepoEnv() strips GH_REPO; a caller that keeps it is asking a
    // different question and must not be served the stripped call's answer.
    await cachedRepoView(ARGS, {
      cwd: repoA,
      env: { ...process.env, GH_REPO: "other/thing" },
    });
    expect(viewCalls()).toHaveLength(2);
  });

  it("caches for a remote-less checkout when GH_REPO identifies the repository", async () => {
    const bare = initRepo("repo-c", "");
    out("repo-c", "acme widgets\n");
    const env = { ...process.env, GH_REPO: "acme/widgets" };
    await cachedRepoView(ARGS, { cwd: bare, env });
    await cachedRepoView(ARGS, { cwd: bare, env });
    expect(viewCalls()).toHaveLength(1);
    // Without GH_REPO nothing identifies the repository: never cached.
    const noEnv = { ...process.env };
    delete noEnv.GH_REPO;
    await cachedRepoView(ARGS, { cwd: bare, env: noEnv });
    await cachedRepoView(ARGS, { cwd: bare, env: noEnv });
    expect(viewCalls()).toHaveLength(3);
  });

  it("invalidates when the checkout is re-pointed at another remote", async () => {
    await cachedRepoView(ARGS, { cwd: repoA });
    runScratch(
      "git",
      ["remote", "set-url", "origin", "git@github.com:acme/renamed.git"],
      {
        cwd: repoA,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
        ) as Record<string, string>,
      },
    );
    await cachedRepoView(ARGS, { cwd: repoA });
    expect(viewCalls()).toHaveLength(2);
    // restore for later tests
    runScratch(
      "git",
      ["remote", "set-url", "origin", "git@github.com:acme/widgets.git"],
      {
        cwd: repoA,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
        ) as Record<string, string>,
      },
    );
  });

  it("expires an entry older than its TTL", async () => {
    await cachedRepoView(ARGS);
    const [entry] = entryFiles();
    const file = join(cacheDir, entry ?? "");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.at = Date.now() - 7 * 60 * 60 * 1000;
    writeFileSync(file, JSON.stringify(doc));
    await cachedRepoView(ARGS);
    expect(viewCalls()).toHaveLength(2);
  });

  it("does not cache when caching is off", async () => {
    delete process.env.JIG_GH_CACHE_DIR;
    await cachedRepoView(ARGS);
    await cachedRepoView(ARGS);
    expect(viewCalls()).toHaveLength(2);
  });

  it("starts no gh call on a cache miss once the caller budget is spent", async () => {
    const r = await cachedRepoView(ARGS, { timeoutSec: 0 });
    expect(r.code).not.toBe(0);
    expect(r.timedOut).toBe(true);
    expect(viewCalls()).toHaveLength(0);
  });
});

describe("ghCacheDir", () => {
  it("is off under NODE_ENV=test unless a directory is given — a suite that forgets to isolate itself runs uncached", () => {
    process.env.NODE_ENV = "test";
    delete process.env.JIG_GH_CACHE_DIR;
    expect(ghCacheDir()).toBeNull();
  });

  it("uses an explicit directory even under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    process.env.JIG_GH_CACHE_DIR = "/somewhere/explicit";
    expect(ghCacheDir()).toBe("/somewhere/explicit");
  });

  it("defaults to ~/.cache/jig/gh-cache outside a test run", () => {
    process.env.NODE_ENV = "production";
    process.env.HOME = "/fake/home";
    delete process.env.JIG_GH_CACHE_DIR;
    expect(ghCacheDir()).toBe(join("/fake/home", ".cache", "jig", "gh-cache"));
  });

  it("JIG_GH_CACHE=off beats both the default and an explicit directory", () => {
    process.env.NODE_ENV = "production";
    process.env.JIG_GH_CACHE = "off";
    process.env.JIG_GH_CACHE_DIR = "/somewhere/explicit";
    expect(ghCacheDir()).toBeNull();
  });
});
