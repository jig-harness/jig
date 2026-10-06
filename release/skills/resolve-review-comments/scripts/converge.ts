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

// skills/resolve-review-comments/scripts/converge.ts
import { lstatSync } from "fs";
import { dirname as dirname2, join as join2 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";

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
function shellQuote(s) {
  if (s !== "" && /^[A-Za-z0-9_\-./:=+@%^]+$/.test(s))
    return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
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

// skills/resolve-review-comments/scripts/converge.ts
var here = dirname2(fileURLToPath2(import.meta.url));
var awaitRound = join2(here, "await-round.ts");
var DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
var RELEASE_SESSIONLESS_LEASE = join2(DRIVE_PR_ROOT, "scripts", "release-sessionless-lease.ts");
async function releaseSessionlessLease(pr) {
  try {
    lstatSync(RELEASE_SESSIONLESS_LEASE);
  } catch {
    return;
  }
  try {
    const r = await run(tsArgv(RELEASE_SESSIONLESS_LEASE, [
      "--pr",
      pr,
      "--what",
      "converge.ts (loop exit)"
    ]), { timeoutSec: 60, stderr: "inherit" });
    if (r.code !== 0) {
      console.error(`converge: could not release this tree's drive lease for PR #${pr} (exit ${r.code}); it clears on its own once stale.`);
    }
  } catch (e) {
    console.error(`converge: could not release this tree's drive lease for PR #${pr} (${e instanceof Error ? e.message : String(e)}); it clears on its own once stale.`);
  }
}
async function main() {
  let pr = "";
  let maxRounds = "10";
  let dryRun = false;
  let botsOnly = false;
  const forward = [];
  const agent = [];
  let sawDdash = false;
  const reflectRaw = envOrDefault("REFLECT_THRESHOLD", "0");
  if (!isDigits(reflectRaw)) {
    fail(2, `REFLECT_THRESHOLD must be a whole number (got '${reflectRaw}')`);
  }
  const argv = process.argv.slice(2);
  const take = (flag, i) => {
    if (i + 1 >= argv.length)
      fail(2, `${flag} requires a value`);
    return argv[i + 1] ?? "";
  };
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (sawDdash) {
      agent.push(a);
      continue;
    }
    switch (a) {
      case "--":
        sawDdash = true;
        break;
      case "--max-rounds":
        maxRounds = take(a, i++);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--bots-only":
        botsOnly = true;
        forward.push(a);
        break;
      case "--no-ci":
        forward.push(a);
        break;
      case "--job-pattern":
      case "--timeout":
      case "--interval":
        forward.push(a, take(a, i++));
        break;
      default:
        if (a.startsWith("--"))
          fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }
  if (!dryRun && agent.length === 0) {
    fail(2, "usage: converge.ts [PR] [--bots-only] -- <command to run one pass> [args...]");
  }
  if (!isSafeDigits(maxRounds))
    fail(2, "--max-rounds takes a whole number within the safe integer range");
  const maxRoundsN = Number.parseInt(maxRounds, 10);
  const explicitPr = pr;
  pr = await resolvePr(pr);
  if (pr === "")
    fail(1, "converge: could not resolve a PR number");
  if (!isDigits(pr))
    fail(2, `converge: PR must be a number (got '${pr}')`);
  process.env.PR = pr;
  process.env.RRC_TARGET_PR = pr;
  if (botsOnly)
    process.env.RRC_BOTS_ONLY = "1";
  if (explicitPr !== "" && agent.length > 0) {
    const token = new RegExp(`(?:^|[^0-9])${explicitPr}(?:[^0-9]|$)`);
    if (!agent.some((word) => token.test(word))) {
      fail(2, `refusing to run: PR #${explicitPr} was given, but the pass command names no PR:`, `  ${agent.map(shellQuote).join(" ")}`, "The pass would target the current branch\u2019s PR instead \u2014 editing and", "resolving threads on a different pull request. Name it explicitly, e.g.", `  converge.ts ${explicitPr} -- codex exec "/resolve-review-comments ${explicitPr}"`);
    }
  }
  if (botsOnly && agent.length > 0) {
    if (!agent.some((word) => word.includes("--bots-only"))) {
      fail(2, "refusing to run: --bots-only was given, but the pass command does not pass it.", "The pass would act on human threads the convergence count excludes.");
    }
  }
  const probeFlags = dryRun ? ["--no-count"] : [];
  let workedARound = false;
  const finish = async (code) => {
    if (workedARound)
      await releaseSessionlessLease(pr);
    return code;
  };
  let round = 0;
  while (round < maxRoundsN) {
    const status = await run(tsArgv(awaitRound, [pr, ...forward, ...probeFlags]), { stdout: "inherit", stderr: "inherit" });
    switch (status.code) {
      case 0:
        break;
      case 3:
        console.error(`converged after ${round} round(s) in this run`);
        return await finish(0);
      default:
        return await finish(status.code);
    }
    round += 1;
    console.error(`--- round ${round}/${maxRoundsN} on PR #${pr} ---`);
    if (dryRun) {
      console.error(`(dry-run) would run: ${agent.map(shellQuote).join(" ")}`);
      return await finish(0);
    }
    const pass = await run(agent, {
      stdinInherit: true,
      stdout: "inherit",
      stderr: "inherit"
    });
    if (!pass.spawnFailed)
      workedARound = true;
    if (pass.code !== 0) {
      console.error(pass.spawnFailed ? `pass command could not be spawned on round ${round} (nothing ran); not resolving further` : `pass failed on round ${round}; not resolving further`);
      return await finish(1);
    }
  }
  console.error(`hit --max-rounds (${maxRoundsN}) without converging on PR #${pr}`);
  return await finish(6);
}
if (isEntryPoint(import.meta.url))
  runMain("converge", main);
