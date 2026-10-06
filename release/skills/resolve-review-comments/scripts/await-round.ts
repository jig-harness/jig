#!/usr/bin/env bun
// @bun

// skills/resolve-review-comments/scripts/lib/consumer.ts
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
function consumerRoot(cwd = process.cwd()) {
  let current = resolve(cwd);
  let gitRoot;
  for (;; ) {
    if (existsSync(join(current, ".groundwork", "install.lock.json")))
      return current;
    if (!gitRoot && existsSync(join(current, ".git")))
      gitRoot = current;
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  return gitRoot ?? resolve(cwd);
}
function siblingSkill(name, scriptDir) {
  const adjacent = join(dirname(dirname(scriptDir)), name);
  if (!existsSync(join(consumerRoot(), ".groundwork", "install.lock.json")))
    return adjacent;
  return join(consumerRoot(), ".claude", "skills", name);
}
function reviewConfig() {
  const override = process.env.GROUNDWORK_OVERLAY;
  const path = override || join(consumerRoot(), ".groundwork", "overlay.json");
  if (!existsSync(path)) {
    if (override)
      throw new Error(`consumer overlay is missing: ${path}`);
    return {};
  }
  const overlay = JSON.parse(readFileSync(path, "utf8"));
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
    throw new Error(`consumer overlay must be an object: ${path}`);
  const review = overlay.review;
  if (review === undefined)
    return {};
  if (!review || typeof review !== "object" || Array.isArray(review))
    throw new Error(`review must be an object: ${path}`);
  for (const [key, value] of Object.entries(review)) {
    if (key === "bots" && (!Array.isArray(value) || value.some((x) => typeof x !== "string")))
      throw new Error("review.bots must be a list of strings");
    if (["job_pattern", "deferral_team", "repo_label", "repo_slug"].includes(key) && typeof value !== "string")
      throw new Error(`review.${key} must be a string`);
    if (key === "taxonomy") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("review.taxonomy must be an object");
      if (["context_prefixes", "types", "repos"].some((field) => Object.hasOwn(value, field)) && !Object.hasOwn(value, "ownership_prefixes"))
        throw new Error("review.taxonomy.ownership_prefixes is required with context_prefixes, types, or repos; declare the ownership label prefixes before filing deferred findings");
      for (const [field, tokens] of Object.entries(value)) {
        if (["provenance_label", "epic_label"].includes(field)) {
          if (typeof tokens !== "string" || !tokens.trim())
            throw new Error(`review.taxonomy.${field} must be a nonempty string`);
        } else if (!Array.isArray(tokens) || !tokens.length || tokens.some((x) => typeof x !== "string" || !x.trim()) || new Set(tokens).size !== tokens.length)
          throw new Error(`review.taxonomy.${field} must contain distinct nonempty strings`);
      }
    }
  }
  return review;
}

// skills/resolve-review-comments/scripts/await-round.ts
import {
  existsSync as existsSync3,
  lstatSync as lstatSync2,
  readFileSync as readFileSync3,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname as dirname3, join as join4 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";

// skills/resolve-review-comments/scripts/lib/cli.ts
import { realpathSync } from "fs";
import { resolve as resolve2 } from "path";
import { setTimeout as sleepMs } from "timers/promises";
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
function isDigits(s) {
  return /^[0-9]+$/.test(s);
}
function isSafeDigits(s) {
  return isDigits(s) && Number.isSafeInteger(Number(s));
}
function envOrDefault(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw;
}
function isEntryPoint(moduleUrl) {
  const argv1 = process.argv[1];
  if (argv1 === undefined)
    return false;
  try {
    return realpathSync(resolve2(argv1)) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
async function sleep(seconds) {
  await sleepMs(seconds * 1000);
}

// skills/resolve-review-comments/scripts/lib/gh-conditional.ts
import { createHash } from "crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { join as join2 } from "path";

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
  return new Promise((resolve3) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve3({
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
      resolve3({
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
      resolve3({
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
function tsArgv(scriptPath, args = []) {
  return [process.execPath, scriptPath, ...args];
}
async function resolvePr(explicit) {
  if (explicit !== "")
    return explicit;
  const r = await ghCall(["pr", "view", "--json", "number", "-q", ".number"], {
    stderr: "ignore"
  });
  if (r.code !== 0)
    return "";
  return r.stdout.trim();
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
  return join2(home, ".cache", "groundwork", "gh-cache");
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
  return join2(dir, `${key}.json`);
}
function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
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
      return { n, t: statSync(join2(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - KEEP_ENTRIES)) {
    rmSync(join2(dir, n), { force: true });
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

// skills/resolve-review-comments/scripts/reply-to-thread.ts
import { existsSync as existsSync2, lstatSync, statSync as statSync2 } from "fs";
import { dirname as dirname2, join as join3 } from "path";
var DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
var DRIVE_PR_SCRIPTS = join3(DRIVE_PR_ROOT, "scripts");
var ASSERT_POST_ALLOWED = join3(DRIVE_PR_SCRIPTS, "assert-post-allowed.ts");
var SKILLS_ROOT = dirname2(DRIVE_PR_ROOT);
function skillsParentIsIntact(parent = SKILLS_ROOT) {
  try {
    return statSync2(parent).isDirectory();
  } catch {
    return false;
  }
}
if (false)
  ;

// skills/resolve-review-comments/scripts/await-round.ts
var here = dirname3(fileURLToPath2(import.meta.url));
var listUnresolved = join4(here, "list-unresolved-threads.ts");
var DRIVE_PR_ROOT2 = siblingSkill("drive-pr", import.meta.dirname);
var SUMMARY_FINDINGS = join4(DRIVE_PR_ROOT2, "scripts", "summary-findings.ts");
var MIN_INTERVAL = 5;
var MAX_QUERY_ERRORS = 3;
var NO_CHECKS_GRACE = 120;
var DEFAULT_CHECKS_MAX_AGE = 300;
var SUMMARY_DEFAULT_TIMEOUT_SEC = 120;
var SUMMARY_ONCE_MARGIN_SEC = 10;
var SUMMARY_ONCE_MIN_TIMEOUT_SEC = 10;
function probeDriveRoot() {
  try {
    lstatSync2(DRIVE_PR_ROOT2);
    return { present: true };
  } catch (e) {
    if (e?.code === "ENOENT" && skillsParentIsIntact(dirname3(DRIVE_PR_ROOT2))) {
      return { present: false, reason: "absent" };
    }
    return { present: false, reason: "error" };
  }
}
async function summaryOnlyFindings(pr, timeoutSec, rootProbe) {
  if (!rootProbe.present) {
    return rootProbe.reason === "absent" ? { kind: "absent" } : { kind: "error" };
  }
  const r = await run(tsArgv(SUMMARY_FINDINGS, [pr, "--json"]), {
    timeoutSec,
    stderr: "inherit"
  });
  if (r.code !== 0)
    return { kind: "error" };
  try {
    const parsed = JSON.parse(r.stdout);
    if (typeof parsed.total !== "number" || !Array.isArray(parsed.unaddressed))
      return { kind: "error" };
    const fps = [];
    for (const f of parsed.unaddressed) {
      if (typeof f?.fingerprint !== "string")
        return { kind: "error" };
      fps.push(f.fingerprint);
    }
    return { kind: "ok", unaddressed: fps };
  } catch {
    return { kind: "error" };
  }
}
async function checkState(pr, jobPattern) {
  const r = await ghCall(["pr", "checks", pr, "--json", "name,bucket,state"], {
    stderr: "ignore"
  });
  if (r.code === 8)
    return "pending";
  if (r.code !== 0 || r.stdout.trim() === "")
    return "error";
  let raw;
  try {
    raw = JSON.parse(r.stdout);
    if (!Array.isArray(raw))
      return "error";
  } catch {
    return "error";
  }
  const matched = jobPattern === null ? raw : raw.filter((c) => jobPattern.test(c.name));
  if (matched.length === 0) {
    if (jobPattern !== null && raw.length > 0)
      return "mismatch";
    return "none";
  }
  if (matched.some((c) => c.bucket === "pending"))
    return "pending";
  let vetoes;
  if (jobPattern !== null) {
    vetoes = matched;
  } else {
    vetoes = raw.filter((c) => /ai[ _-]?review|codex|coderabbit/i.test(c.name));
    if (vetoes.length === 0)
      return "no-reviewer";
  }
  const liveVetoes = vetoes.filter((c) => c.state !== "SKIPPED");
  if (liveVetoes.length === 0)
    return "no-reviewer";
  if (liveVetoes.some((c) => c.bucket !== "pass" && c.state !== "NEUTRAL")) {
    return "failed";
  }
  return "settled";
}
async function main() {
  const mainStartedAt = Date.now();
  let pr = "";
  let botsOnly = false;
  let jobPatternRaw = reviewConfig().job_pattern ?? "";
  let once = false;
  let noCi = false;
  let noCount = false;
  let onceBudgetRaw = null;
  const argv = process.argv.slice(2);
  const take = (flag, i) => {
    if (i + 1 >= argv.length)
      fail(2, `${flag} requires a value`);
    return argv[i + 1] ?? "";
  };
  let timeoutRaw = "1800";
  let intervalRaw = "30";
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--bots-only":
        botsOnly = true;
        break;
      case "--job-pattern":
        jobPatternRaw = take(a, i++);
        break;
      case "--timeout":
        timeoutRaw = take(a, i++);
        break;
      case "--interval":
        intervalRaw = take(a, i++);
        break;
      case "--once":
        once = true;
        break;
      case "--no-ci":
        noCi = true;
        break;
      case "--no-count":
        noCount = true;
        break;
      case "--once-budget-sec":
        onceBudgetRaw = take(a, i++);
        break;
      default:
        if (a.startsWith("--"))
          fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }
  if (!isSafeDigits(timeoutRaw) || !isSafeDigits(intervalRaw)) {
    fail(2, "--timeout and --interval take whole seconds");
  }
  const timeout = Number.parseInt(timeoutRaw, 10);
  const interval = Number.parseInt(intervalRaw, 10);
  if (interval < MIN_INTERVAL) {
    fail(2, `--interval must be at least ${MIN_INTERVAL}s (got ${interval})`);
  }
  if (interval * 1000 > 2147483647) {
    fail(2, `--interval must be at most 2147483s (got ${interval})`);
  }
  if (timeout < interval) {
    fail(2, `--timeout (${timeout}s) must be at least one --interval (${interval}s)`);
  }
  let onceBudgetSec = null;
  if (onceBudgetRaw !== null) {
    const parsed = isDigits(onceBudgetRaw) ? Number.parseInt(onceBudgetRaw, 10) : Number.NaN;
    if (Number.isNaN(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed) || parsed * 1000 > 2147483647) {
      fail(2, "--once-budget-sec must be a positive whole number of seconds no greater than 2147483");
    }
    onceBudgetSec = parsed;
  }
  let jobPattern = null;
  if (jobPatternRaw !== "") {
    try {
      jobPattern = new RegExp(jobPatternRaw);
    } catch (e) {
      fail(2, `--job-pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const checksMaxAgeRaw = envOrDefault("AWAIT_ROUND_CHECKS_MAX_AGE", String(DEFAULT_CHECKS_MAX_AGE));
  const checksMaxAgeSec = Number.parseInt(checksMaxAgeRaw, 10);
  if (!isDigits(checksMaxAgeRaw) || !Number.isSafeInteger(checksMaxAgeSec) || checksMaxAgeSec > 86400) {
    fail(2, `AWAIT_ROUND_CHECKS_MAX_AGE must be a whole number of seconds, at most 86400 (got '${checksMaxAgeRaw}')`);
  }
  const checksMaxAgeMs = checksMaxAgeSec * 1000;
  const reflectRaw = envOrDefault("REFLECT_THRESHOLD", "3");
  if (!isDigits(reflectRaw)) {
    fail(2, `REFLECT_THRESHOLD must be a whole number (got '${reflectRaw}')`);
  }
  const reflectThreshold = Number.parseInt(reflectRaw, 10);
  pr = await resolvePr(pr);
  if (pr === "")
    fail(1, "await-round: could not resolve a PR number");
  if (!isDigits(pr)) {
    fail(2, `await-round: PR must be a number (got '${pr}')`);
  }
  let roundsFile = "";
  let roundsHeadFile = "";
  const gitDir = await git(["rev-parse", "--git-dir"], { stderr: "ignore" });
  if (gitDir.code === 0 && gitDir.stdout.trim() !== "") {
    roundsFile = join4(gitDir.stdout.trim(), `resolve-review-rounds-${pr}`);
    roundsHeadFile = `${roundsFile}.head`;
  }
  const currentHead = async () => {
    const l = await readPrLiveness(pr);
    return l.ok ? l.head : "";
  };
  const readCount = (file) => {
    let n = "";
    try {
      n = readFileSync3(file, "utf8").trim();
    } catch {
      return 0;
    }
    return isDigits(n) && n !== "" ? Number.parseInt(n, 10) : 0;
  };
  const bumpRounds = async () => {
    if (noCount || roundsFile === "")
      return;
    const head = await currentHead();
    if (head === "")
      return;
    if (existsSync3(roundsHeadFile)) {
      const lastHead = readFileSync3(roundsHeadFile, "utf8").trim();
      if (head === lastHead)
        return;
    }
    const n = readCount(roundsFile) + 1;
    writeFileSync2(roundsHeadFile, `${head}
`);
    writeFileSync2(roundsFile, `${n}
`);
    if (n > reflectThreshold) {
      console.error(`round ${n} on #${pr}: if this round's accepted fixes target the same root cause as the last round's (another race vector, another scanner depth, another heuristic), stop patching variants \u2014 propose the structural fix or defer it (SKILL.md step 3)`);
    }
  };
  const reportRoundsAndReset = () => {
    if (roundsFile === "")
      return;
    if (noCount)
      return;
    const n = readCount(roundsFile);
    rmSync2(roundsFile, { force: true });
    rmSync2(roundsHeadFile, { force: true });
    if (n <= reflectThreshold)
      return;
    console.error(`
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  #${pr} converged after ${n} rounds (> ${reflectThreshold}).

  That many rounds usually means the scaffolding under-served
  this change, not that the reviewer was noisy. Now that the
  rounds have wound down, run /reflect while the detail is
  still recoverable, and consider whether the fix belongs in
  an instruction file, a skill, a rule, or the reviewer config.
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
  };
  const unresolvedCount = async () => {
    const args = botsOnly ? [pr, "--bots-only"] : [pr];
    const r = await run(tsArgv(listUnresolved, args), { stderr: "inherit" });
    if (r.code !== 0) {
      fail(1, `could not enumerate unresolved threads for #${pr} (exit ${r.code})`);
    }
    return r.stdout.split(`
`).filter((l) => l.trim() !== "").length;
  };
  const deadline = Date.now() + timeout * 1000;
  let queryErrors = 0;
  let noChecksSince = null;
  const waitOrGiveUp = async () => {
    if (once) {
      console.error("not settled yet; --once given, not waiting");
      return false;
    }
    if (Date.now() >= deadline) {
      console.error(`timed out after ${timeout}s waiting for checks to settle`);
      return false;
    }
    await sleep(interval);
    return true;
  };
  let lastWaiting = null;
  for (;; ) {
    const live = await readPrLiveness(pr);
    if (!live.ok)
      fail(1, `cannot read state of PR #${pr}`, live.reason);
    const liveHead = live.head;
    if (live.state !== "OPEN") {
      fail(5, `PR #${pr} is ${live.state} \u2014 abandoning the loop (further pushes would be orphaned)`);
    }
    const signalsUnchanged = liveHead !== "" && !once && checksMaxAgeMs > 0 ? await checkSignalsUnchanged(liveHead) : false;
    let cs;
    if (lastWaiting !== null && signalsUnchanged && lastWaiting.head === liveHead && Date.now() - lastWaiting.at < checksMaxAgeMs) {
      cs = lastWaiting.state;
    } else {
      cs = await checkState(pr, jobPattern);
      lastWaiting = liveHead !== "" && (cs === "pending" || cs === "no-reviewer") ? { state: cs, head: liveHead, at: Date.now() } : null;
    }
    switch (cs) {
      case "error": {
        queryErrors += 1;
        if (once) {
          fail(1, `could not read checks for #${pr} \u2014 refusing to guess`);
        }
        if (queryErrors >= MAX_QUERY_ERRORS) {
          fail(1, `could not read checks for #${pr} after ${queryErrors} attempts \u2014 refusing to guess`);
        }
        console.error(`check query failed (${queryErrors}/${MAX_QUERY_ERRORS}); retrying`);
        if (!await waitOrGiveUp())
          return 4;
        continue;
      }
      case "pending":
        queryErrors = 0;
        noChecksSince = null;
        if (!await waitOrGiveUp())
          return 4;
        continue;
      case "none":
        queryErrors = 0;
        if (noCi) {
          console.error(`no checks on #${pr}; --no-ci given, treating as settled`);
        } else {
          if (noChecksSince === null)
            noChecksSince = Date.now();
          if (Date.now() - noChecksSince < NO_CHECKS_GRACE * 1000) {
            console.error(`no checks yet on #${pr}; waiting ${NO_CHECKS_GRACE}s for the suite to appear`);
            if (!await waitOrGiveUp())
              return 4;
            continue;
          }
          console.error(`no checks on #${pr} after ${NO_CHECKS_GRACE}s \u2014 assuming no CI (pass --no-ci to skip this wait)`);
        }
        break;
      case "no-reviewer":
        queryErrors = 0;
        noChecksSince = null;
        console.error(`checks exist on #${pr} but no reviewer-shaped check has been observed yet; waiting`);
        if (!await waitOrGiveUp())
          return 4;
        continue;
      case "mismatch":
        fail(2, `--job-pattern '${jobPatternRaw}' matched none of this PR's checks.`, "Refusing to treat that as settled \u2014 fix the pattern, or omit it.");
        break;
      case "failed":
        fail(7, `a matching check FAILED on #${pr} \u2014 it may never have posted its findings,`, "so a zero thread count here would not mean the round was clean.");
        break;
      case "settled":
        queryErrors = 0;
        noChecksSince = null;
        break;
    }
    const count = await unresolvedCount();
    if (count > 0) {
      await bumpRounds();
      console.error(`round ready: ${count} unresolved thread(s) on #${pr}`);
      return 0;
    }
    const rootProbe = probeDriveRoot();
    let summaryTimeoutSec = SUMMARY_DEFAULT_TIMEOUT_SEC;
    if (once && onceBudgetSec !== null && rootProbe.present) {
      const remainingSec = onceBudgetSec - SUMMARY_ONCE_MARGIN_SEC - Math.floor((Date.now() - mainStartedAt) / 1000);
      if (remainingSec < SUMMARY_ONCE_MIN_TIMEOUT_SEC) {
        fail(1, `0 unresolved thread(s) on #${pr}, but too little of the declared --once-budget-sec (${onceBudgetSec}s) remains (${remainingSec}s left) to safely check /drive-pr's summary-findings.ts \u2014 refusing to report converged`);
      }
      summaryTimeoutSec = remainingSec;
    }
    const so = await summaryOnlyFindings(pr, summaryTimeoutSec, rootProbe);
    if (so.kind === "error") {
      fail(1, `0 unresolved thread(s) on #${pr}, but /drive-pr's summary-findings.ts could not be read \u2014 cannot confirm no summary-only finding is outstanding; refusing to report converged`);
    }
    if (so.kind === "ok" && so.unaddressed.length > 0) {
      console.error(`summary-only findings outstanding: 0 unresolved thread(s) on #${pr}, but ${so.unaddressed.length} finding(s) live only in the reviewer's summary comment (${so.unaddressed.join(", ")}).`);
      console.error(`  A thread-driven pass cannot see them. Answer them with /drive-pr (answer-summary-finding.ts), fix and push, or hand them to a human.`);
      return 8;
    }
    if (so.kind === "absent") {
      console.error(`note: /drive-pr is not installed beside this skill, so summary-only findings on #${pr} were not checked (TASK standalone residual)`);
    }
    console.error(`converged: 0 unresolved thread(s) on #${pr}, checks settled`);
    reportRoundsAndReset();
    return 3;
  }
}
if (isEntryPoint(import.meta.url))
  runMain("await-round", main);
