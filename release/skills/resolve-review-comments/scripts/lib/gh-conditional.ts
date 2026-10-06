// @bun
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

// skills/resolve-review-comments/scripts/lib/cli.ts
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

// skills/resolve-review-comments/scripts/lib/proc.ts
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
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve({
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
      resolve({
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
      resolve({
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
function parseResponse(out) {
  const gap = /\r?\n\r?\n/.exec(out);
  const head = gap ? out.slice(0, gap.index) : out;
  const body = gap ? out.slice(gap.index + gap[0].length) : "";
  const lines = head.split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? "");
  if (!status)
    return null;
  let etag = "";
  for (const line of lines.slice(1)) {
    const m = /^etag:\s*(.+)$/i.exec(line);
    if (m)
      etag = (m[1] ?? "").trim();
  }
  return { status: Number.parseInt(status[1] ?? "0", 10), etag, body };
}
function ghConditionalGet(path, ctx = {}) {
  return conditional(path, ctx, true);
}
function ghConditionalProbe(path, ctx = {}) {
  return conditional(path, ctx, false);
}
var probeBaselines = new Map;
function resetProbeBaselines() {
  probeBaselines.clear();
}
async function conditional(path, ctx, keepBody) {
  const startMs = Date.now();
  const request = keepBody ? path : `etag-only ${path}`;
  const dir = ghCacheDir();
  const scope = dir === null ? null : await repoScope(ctx);
  const file = dir !== null && scope !== null ? entryFile(dir, scope, request) : null;
  let cached = null;
  if (file !== null && !keepBody) {
    const etag = probeBaselines.get(file);
    if (etag !== undefined)
      cached = { etag, body: "" };
  } else if (file !== null) {
    const e = readJsonFile(file);
    if (e !== null && e.v === ENTRY_VERSION && e.path === request && typeof e.etag === "string" && e.etag !== "" && typeof e.body === "string") {
      cached = { etag: e.etag, body: e.body };
    }
  }
  const left = budgetLeftSec(ctx, startMs);
  if (left === 0) {
    return { ok: false, reason: `gh api ${path}: caller budget exhausted` };
  }
  const r = await ghCall([
    "api",
    "-i",
    ...cached ? ["-H", `If-None-Match: ${cached.etag}`] : [],
    ...ctx.caller ? ["-H", `X-Drive-Pr-Caller: ${ctx.caller}`] : [],
    path
  ], { cwd: ctx.cwd, env: ctx.env, timeoutSec: left });
  if (r.timedOut)
    return { ok: false, reason: `gh api ${path} timed out` };
  if (r.bufferExceeded) {
    return { ok: false, reason: `gh api ${path} output exceeded the buffer` };
  }
  const parsed = parseResponse(r.stdout);
  if (parsed === null) {
    return {
      ok: false,
      reason: `gh api ${path}: unparseable response (exit ${r.code})`
    };
  }
  if (parsed.status === 304) {
    return cached ? { ok: true, changed: false, body: cached.body } : { ok: false, reason: `gh api ${path}: 304 with nothing cached` };
  }
  if (parsed.status >= 200 && parsed.status < 300 && r.code === 0) {
    if (file !== null && !keepBody) {
      if (parsed.etag !== "")
        probeBaselines.set(file, parsed.etag);
      else
        probeBaselines.delete(file);
    } else if (file !== null && dir !== null && parsed.etag !== "") {
      writeJsonFile(dir, file, {
        v: ENTRY_VERSION,
        path: request,
        etag: parsed.etag,
        body: parsed.body
      });
    }
    return { ok: true, changed: true, body: parsed.body };
  }
  return {
    ok: false,
    reason: `gh api ${path}: HTTP ${parsed.status} (exit ${r.code})`
  };
}
async function readPrLiveness(pr, ctx = {}) {
  if (!/^\d+$/.test(pr))
    return { ok: false, reason: "PR is not a number" };
  const r = await ghConditionalGet(`repos/{owner}/{repo}/pulls/${pr}`, ctx);
  if (!r.ok)
    return r;
  let j;
  try {
    const parsed = JSON.parse(r.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: `pulls/${pr}: response is not an object` };
    }
    j = parsed;
  } catch {
    return { ok: false, reason: `pulls/${pr}: unparseable JSON` };
  }
  const sha = j.head?.sha;
  const head = typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha) ? sha : "";
  if (j.state !== "open" && j.state !== "closed") {
    return { ok: false, reason: `pulls/${pr}: unrecognised state` };
  }
  if (j.merged === true)
    return { ok: true, state: "MERGED", head };
  return { ok: true, state: j.state === "open" ? "OPEN" : "CLOSED", head };
}
async function checkSignalsUnchanged(sha) {
  if (!/^[0-9a-f]{40,64}$/.test(sha))
    return false;
  const [runs, statuses] = await Promise.all([
    ghConditionalProbe(`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`),
    ghConditionalProbe(`repos/{owner}/{repo}/commits/${sha}/status`)
  ]);
  return runs.ok && !runs.changed && statuses.ok && !statuses.changed;
}
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
export {
  cachedRepoView,
  checkSignalsUnchanged,
  ghCacheDir,
  ghConditionalGet,
  ghConditionalProbe,
  readPrLiveness,
  repoScope,
  resetProbeBaselines
};
