#!/usr/bin/env bun
// @bun

// skills/resolve-review-comments/scripts/lib/cli.ts
import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

class ExitError extends Error {
  code;
  constructor(code, message) {
    super(message ?? `exit ${code}`);
    this.code = code;
  }
}
function fail(code, ...lines) {
  for (const line of lines)
    console.error(line);
  throw new ExitError(code);
}
function runMain(name, main) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    if (e instanceof ExitError) {
      process.exitCode = e.code;
      return;
    }
    console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
function isEntryPoint(moduleUrl) {
  const argv1 = process.argv[1];
  if (argv1 === undefined)
    return false;
  try {
    return realpathSync(resolve(argv1)) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

// skills/resolve-review-comments/scripts/lib/gh-conditional.ts
import { createHash } from "crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { join } from "path";

// skills/resolve-review-comments/scripts/lib/proc.ts
import { spawn } from "child_process";
function readTimeoutEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "")
    return { ok: true, seconds: def };
  if (!/^[0-9]+$/.test(raw) || /^0+$/.test(raw))
    return { ok: false, raw };
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 > 2147483647) {
    return { ok: false, raw };
  }
  return { ok: true, seconds };
}
function ghCallTimeoutSeconds() {
  const read = readTimeoutEnv("GH_CALL_TIMEOUT", 30);
  if (read.ok)
    return read.seconds;
  if (/^0+$/.test(read.raw)) {
    fail(1, "gh-deadline: GH_CALL_TIMEOUT=0 disables the deadline instead of firing immediately \u2014 refusing");
  }
  fail(1, `gh-deadline: GH_CALL_TIMEOUT must be a positive whole number of seconds no`, `greater than 2147483 (got '${read.raw}') \u2014 beyond that the millisecond delay`, "overflows a 32-bit timer and fires immediately, inverting the deadline.");
}
var MAX_BUFFER_BYTES = 64 * 1024 * 1024;
var registryKey = Symbol.for("groundwork.review.process-cancellation.v1");
var globalRegistry = globalThis;
var cancellation = globalRegistry[registryKey] ?? {
  groups: new Map,
  handlers: new Map
};
globalRegistry[registryKey] = cancellation;
var cancellableGroups = cancellation.groups;
function registerCancellationGroup(pgid) {
  const token = Symbol();
  let registrations = cancellableGroups.get(pgid);
  if (!registrations) {
    registrations = new Set;
    cancellableGroups.set(pgid, registrations);
  }
  registrations.add(token);
  let released = false;
  return () => {
    if (released)
      return;
    released = true;
    registrations.delete(token);
    if (registrations.size === 0)
      cancellableGroups.delete(pgid);
  };
}
var CANCEL_ESCALATE_MS = 250;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function signalGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
  } catch {}
}
function cancelTrackedGroups() {
  const groups = [...cancellableGroups.keys()];
  if (groups.length === 0)
    return;
  for (const pgid of groups)
    signalGroup(pgid, "SIGTERM");
  sleepSync(CANCEL_ESCALATE_MS);
  for (const pgid of groups)
    signalGroup(pgid, "SIGKILL");
}
var CANCEL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of CANCEL_SIGNALS) {
  if (cancellation.handlers.has(sig))
    continue;
  const forward = () => {
    cancelTrackedGroups();
    if (process.listenerCount(sig) === 1) {
      process.removeListener(sig, forward);
      cancellation.handlers.delete(sig);
      process.kill(process.pid, sig);
    }
  };
  cancellation.handlers.set(sig, forward);
  process.on(sig, forward);
}
function run(argv, opts = {}) {
  return new Promise((resolve2) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve2({
        code: 127,
        stdout: "",
        stderr: "empty command",
        bufferExceeded: false,
        timedOut: false,
        spawnFailed: true
      });
      return;
    }
    const detached = opts.timeoutSec !== undefined && process.platform !== "win32";
    const spawnOpts = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached,
      stdio: [
        opts.stdinInherit ? "inherit" : opts.stdin === undefined ? "ignore" : "pipe",
        opts.stdout ?? "pipe",
        opts.stderr ?? "pipe"
      ]
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      resolve2({
        code: 127,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: true
      });
      return;
    }
    const cancellableGroup = detached ? child.pid : undefined;
    const unregisterGroup = cancellableGroup === undefined ? undefined : registerCancellationGroup(cancellableGroup);
    let out = "";
    let err = "";
    let timedOut = false;
    let bufferExceeded = false;
    let spawnFailed = false;
    let capturedBytes = 0;
    let killTimer;
    let escalateTimer;
    const maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_BYTES;
    const enforceBufferLimit = () => {
      if (bufferExceeded || timedOut)
        return;
      if (capturedBytes <= maxBufferBytes)
        return;
      bufferExceeded = true;
      if (killTimer)
        clearTimeout(killTimer);
      signalTree("SIGTERM");
      escalateTimer = setTimeout(() => {
        signalTree("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle(1);
      }, 2000);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      const captured = !(bufferExceeded || timedOut);
      if (captured) {
        out += d;
        capturedBytes += Buffer.byteLength(d);
      }
      opts.onChunk?.("stdout", Buffer.byteLength(d), captured);
      enforceBufferLimit();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d) => {
      const captured = !(bufferExceeded || timedOut);
      if (captured) {
        err += d;
        capturedBytes += Buffer.byteLength(d);
      }
      opts.onChunk?.("stderr", Buffer.byteLength(d), captured);
      enforceBufferLimit();
    });
    const settle = (code, extraErr) => {
      if (killTimer)
        clearTimeout(killTimer);
      if (escalateTimer)
        clearTimeout(escalateTimer);
      unregisterGroup?.();
      resolve2({
        code,
        stdout: out,
        stderr: err || (extraErr ?? ""),
        timedOut,
        bufferExceeded,
        spawnFailed
      });
    };
    const signalTree = (sig) => {
      if (child.pid === undefined)
        return;
      if (process.platform === "win32") {
        if (sig === "SIGKILL") {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
            killer.on("error", () => {
              try {
                child.kill(sig);
              } catch {}
            });
            killer.unref();
          } catch {
            child.kill(sig);
          }
        }
        return;
      }
      try {
        if (detached)
          process.kill(-child.pid, sig);
        else
          child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    if (opts.timeoutSec !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true;
        signalTree("SIGTERM");
        escalateTimer = setTimeout(() => {
          signalTree("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          settle(124);
        }, 2000);
      }, opts.timeoutSec * 1000);
    }
    child.on("error", (e) => {
      spawnFailed = true;
      settle(127, e.message);
    });
    child.on("close", (code) => {
      if (timedOut || bufferExceeded)
        signalTree("SIGKILL");
      settle(timedOut ? 124 : bufferExceeded ? 1 : code ?? 1);
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
function ghCall(args, opts = {}) {
  const envDeadline = ghCallTimeoutSeconds();
  const { timeoutSec, ...rest } = opts;
  return run(["gh", ...args], {
    ...rest,
    timeoutSec: timeoutSec === undefined ? envDeadline : Math.max(1, Math.min(envDeadline, timeoutSec))
  });
}
function git(args, opts = {}) {
  return run(["git", ...args], opts);
}

// skills/resolve-review-comments/scripts/lib/gh-conditional.ts
var MAX_ENTRIES = 256;
var KEEP_ENTRIES = 128;
var REPO_VIEW_TTL_MS = 6 * 60 * 60 * 1000;
var ENTRY_VERSION = 1;
var GIT_PROBE_TIMEOUT_SEC = 10;
function ghCacheDir() {
  if ((process.env.GROUNDWORK_GH_CACHE ?? "") === "off")
    return null;
  const explicit = process.env.GROUNDWORK_GH_CACHE_DIR ?? "";
  if (explicit !== "")
    return explicit;
  if (false)
    ;
  const home = process.env.HOME || homedir();
  if (!home)
    return null;
  return join(home, ".cache", "groundwork", "gh-cache");
}
function budgetLeftSec(ctx, startMs) {
  if (ctx.timeoutSec === undefined)
    return;
  return Math.max(0, Math.ceil(ctx.timeoutSec - (Date.now() - startMs) / 1000));
}
function repoScope(ctx = {}) {
  const env = ctx.env ?? process.env;
  return (async () => {
    const startMs = Date.now();
    const opts = () => ({
      stderr: "ignore",
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutSec: Math.min(GIT_PROBE_TIMEOUT_SEC, budgetLeftSec(ctx, startMs) ?? GIT_PROBE_TIMEOUT_SEC)
    });
    if (budgetLeftSec(ctx, startMs) === 0)
      return null;
    const remotes = await git(["remote", "-v"], opts());
    if (remotes.code !== 0)
      return null;
    if (remotes.stdout.trim() === "" && !env.GH_REPO)
      return null;
    if (budgetLeftSec(ctx, startMs) === 0)
      return null;
    const resolved = await git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], opts());
    if (resolved.code !== 0 && !(resolved.code === 1 && resolved.stdout === "")) {
      return null;
    }
    return createHash("sha256").update([
      env.GH_HOST ?? "",
      env.GH_REPO ?? "",
      remotes.stdout,
      resolved.stdout
    ].join(`
--
`)).digest("hex");
  })();
}
function entryFile(dir, scope, request) {
  const key = createHash("sha256").update(`${scope}
${request}`).digest("hex").slice(0, 40);
  return join(dir, `${key}.json`);
}
function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function writeJsonFile(dir, file, value) {
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    chmodSync(dir, 448);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 384 });
    renameSync(tmp, file);
    prune(dir);
  } catch {}
}
function prune(dir) {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (names.length <= MAX_ENTRIES)
    return;
  const aged = names.map((n) => {
    try {
      return { n, t: statSync(join(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - KEEP_ENTRIES)) {
    rmSync(join(dir, n), { force: true });
  }
}
var probeBaselines = new Map;
async function cachedRepoView(args, opts = {}) {
  const startMs = Date.now();
  const dir = ghCacheDir();
  const scope = dir === null ? null : await repoScope(opts);
  const request = `repo view ${JSON.stringify(args)}`;
  const file = dir !== null && scope !== null ? entryFile(dir, scope, request) : null;
  if (file !== null) {
    const e = readJsonFile(file);
    if (e !== null && e.v === ENTRY_VERSION && e.request === request && typeof e.stdout === "string" && e.stdout.trim() !== "" && typeof e.at === "number" && Date.now() - e.at < REPO_VIEW_TTL_MS) {
      const hit = {
        code: 0,
        stdout: e.stdout,
        stderr: "",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false
      };
      return hit;
    }
  }
  const left = budgetLeftSec(opts, startMs);
  if (left === 0) {
    return {
      code: 1,
      stdout: "",
      stderr: "gh repo view: caller budget exhausted",
      timedOut: true,
      bufferExceeded: false,
      spawnFailed: false
    };
  }
  const r = await ghCall(["repo", "view", ...args], {
    ...opts,
    timeoutSec: left
  });
  if (file !== null && dir !== null && r.code === 0 && !r.timedOut && r.stdout.trim() !== "") {
    writeJsonFile(dir, file, {
      v: ENTRY_VERSION,
      request,
      stdout: r.stdout,
      at: Date.now()
    });
  }
  return r;
}

// skills/resolve-review-comments/scripts/lib/gh.ts
async function ghOrExit(label, args, opts = {}) {
  const factor = opts.deadlineFactor ?? 1;
  const baseSeconds = ghCallTimeoutSeconds();
  const timeoutSec = baseSeconds * factor;
  if (timeoutSec * 1000 > 2147483647) {
    fail(1, `${label}: GH_CALL_TIMEOUT (${baseSeconds}s) \xD7 deadlineFactor (${factor}) overflows the deadline timer \u2014 refusing`);
  }
  const r = await run(["gh", ...args], { timeoutSec });
  if (r.timedOut) {
    fail(1, `${label}: gh ${args[0] ?? ""} killed after ${timeoutSec * 1000}ms`);
  }
  if (r.bufferExceeded) {
    fail(1, `${label}: gh ${args[0] ?? ""} output exceeded ${MAX_BUFFER_BYTES / (1024 * 1024)}MiB \u2014 killed`);
  }
  if (r.code !== 0) {
    fail(r.code, ...r.stderr ? [r.stderr] : []);
  }
  return r.stdout;
}
async function repoViewOrExit(label, args) {
  const r = await cachedRepoView(args);
  if (r.timedOut) {
    fail(1, `${label}: gh repo view killed after ${ghCallTimeoutSeconds() * 1000}ms`);
  }
  if (r.code !== 0) {
    fail(r.code, ...r.stderr ? [r.stderr] : []);
  }
  return r.stdout;
}

// skills/resolve-review-comments/scripts/list-unresolved-threads.ts
var redactReplyIds = (body) => body == null ? null : body.replace(/#discussion_r\d+/g, "#discussion_r[redacted]");
var gh = (args, opts) => ghOrExit("list-unresolved-threads", args, opts);
async function main() {
  let pr = "";
  let botsOnly = false;
  let includeResolved = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--bots-only")
      botsOnly = true;
    else if (a === "--include-resolved")
      includeResolved = true;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      return 2;
    } else
      pr = a;
  }
  if (pr === "")
    pr = (await gh(["pr", "view", "--json", "number", "-q", ".number"])).trim();
  const target = process.env.RRC_TARGET_PR ?? "";
  if (target !== "" && target !== pr) {
    console.error(`list-unresolved-threads: the run is working PR #${target}, but this pass resolved PR #${pr}.`);
    console.error("Enumerating here would hand the pass thread ids on a different pull request.");
    return 2;
  }
  if ((process.env.RRC_BOTS_ONLY ?? "") !== "")
    botsOnly = true;
  if (!/^[0-9]+$/.test(pr)) {
    console.error(`list-unresolved-threads: PR must be a number (got '${pr}')`);
    return 2;
  }
  const repoLine = (await repoViewOrExit("list-unresolved-threads", [
    "--json",
    "owner,name",
    "-q",
    '.owner.login + " " + .name'
  ])).trim();
  const [owner, repo] = repoLine.split(" ");
  const pagesRaw = await gh([
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `pr=${pr}`,
    "-f",
    `query=
  query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String){
    repository(owner:$owner, name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100, after:$endCursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id isResolved isOutdated path line startLine diffSide startDiffSide
            comments(first:100){ pageInfo{ hasNextPage } nodes{ url author{ login __typename } authorAssociation body } }
          }
        }
      }
    }
  }`
  ], { deadlineFactor: 4 });
  let pages;
  try {
    pages = JSON.parse(pagesRaw);
  } catch {
    console.error("list-unresolved-threads: gh returned unparsable JSON");
    return 1;
  }
  const pageList = Array.isArray(pages) ? pages : [pages];
  for (const page of pageList) {
    const shaped = page;
    if (shaped?.data?.repository == null) {
      console.error(`list-unresolved-threads: repository ${owner}/${repo} could not be read \u2014 refusing to report zero threads`);
      return 1;
    }
    if (shaped.data.repository.pullRequest == null) {
      console.error(`list-unresolved-threads: PR #${pr} does not exist in ${owner}/${repo} \u2014 refusing to report zero threads.`);
      console.error("Check the number, and check that $GH_REPO / `gh repo set-default` agree with", "the repository the PR actually lives in.");
      return 1;
    }
    const nodes = shaped.data.repository.pullRequest.reviewThreads?.nodes ?? [];
    for (const t of nodes) {
      if (!includeResolved && t.isResolved !== false)
        continue;
      const startedByBot = t.comments.nodes[0]?.author?.__typename === "Bot";
      const confirmedHumanStarted = t.comments.nodes[0]?.author?.__typename === "User";
      const historyOnly = botsOnly && !startedByBot;
      if (historyOnly && !includeResolved)
        continue;
      process.stdout.write(`${JSON.stringify({
        threadId: historyOnly ? null : t.id,
        redacted: historyOnly || undefined,
        confirmedHumanStarted,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        diffSide: t.diffSide,
        startDiffSide: t.startDiffSide,
        isResolved: t.isResolved !== false,
        isOutdated: t.isOutdated,
        url: historyOnly ? null : t.comments.nodes[0]?.url ?? null,
        commentsTruncated: t.comments.pageInfo.hasNextPage,
        comments: t.comments.nodes.map((c) => ({
          author: c.author?.login ?? null,
          authorAssociation: c.authorAssociation ?? null,
          body: historyOnly ? redactReplyIds(c.body) : c.body ?? null,
          url: historyOnly ? null : c.url ?? null
        }))
      })}
`);
    }
  }
  return 0;
}
if (isEntryPoint(import.meta.url))
  runMain("list-unresolved-threads", main);
