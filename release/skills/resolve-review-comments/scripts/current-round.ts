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

// skills/resolve-review-comments/scripts/current-round.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";

// skills/resolve-review-comments/scripts/lib/cli.ts
import { realpathSync } from "fs";
import { resolve as resolve2 } from "path";
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

// skills/resolve-review-comments/scripts/current-round.ts
var DRIVE_STATE = join2(siblingSkill("drive-pr", import.meta.dirname), "scripts", "drive-state.ts");
async function drivePrRounds(pr) {
  if (!existsSync2(DRIVE_STATE))
    return [0, ""];
  const r = await run([process.execPath, DRIVE_STATE, "rounds", pr], {
    timeoutSec: 30
  });
  if (r.code !== 0) {
    const why = r.timedOut ? "timed out" : `exited ${r.code}`;
    return [0, `drive-pr round count unavailable (${why})`];
  }
  const out = r.stdout.trim();
  if (!isRoundOrdinal(out)) {
    if (out === "0")
      return [0, ""];
    return [
      0,
      `drive-pr round count is not a canonical ordinal (${JSON.stringify(out)})`
    ];
  }
  return [Number.parseInt(out, 10), ""];
}
function isRoundOrdinal(raw) {
  const n = raw.trim();
  return n[0] !== "0" && isSafeDigits(n);
}
function parseRoundCount(raw) {
  if (raw === null || !isRoundOrdinal(raw))
    return 0;
  return Number.parseInt(raw.trim(), 10);
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 1 || argv[0]?.startsWith("--")) {
    fail(2, "usage: current-round.ts [PR]");
  }
  const pr = await resolvePr(argv[0] ?? "");
  if (pr === "" || !isDigits(pr)) {
    fail(1, "current-round: could not resolve a PR number");
  }
  const gitDir = await git(["rev-parse", "--git-dir"], { stderr: "ignore" });
  if (gitDir.code !== 0 || gitDir.stdout.trim() === "") {
    fail(1, "current-round: not inside a git repository");
  }
  const counter = join2(gitDir.stdout.trim(), `resolve-review-rounds-${pr}`);
  let raw = null;
  let unreadable = "";
  try {
    raw = readFileSync2(counter, "utf8");
  } catch (err) {
    const code = err?.code ?? "";
    if (code !== "ENOENT")
      unreadable = code === "" ? String(err) : code;
    raw = null;
  }
  const indeterminate = unreadable !== "" ? `is unreadable (${unreadable})` : raw !== null && !isRoundOrdinal(raw) ? `holds no round ordinal (${JSON.stringify(raw.slice(0, 40))})` : "";
  if (indeterminate !== "") {
    console.error(`current-round: counter ${counter} ${indeterminate} \u2014 reading 0, so the round-indexed cutoff does not arm this pass`);
  }
  const [driveRounds, driveWhy] = await drivePrRounds(pr);
  if (driveWhy !== "") {
    console.error(`current-round: ${driveWhy} \u2014 reading 0 for that loop, so the round-indexed cutoff may not arm this pass`);
  }
  console.log(String(Math.max(parseRoundCount(raw), driveRounds)));
  return 0;
}
if (isEntryPoint(import.meta.url))
  runMain("current-round", main);
export {
  isRoundOrdinal,
  parseRoundCount
};
