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

// skills/resolve-review-comments/scripts/reply-to-thread.ts
import { existsSync as existsSync2, lstatSync, statSync } from "fs";
import { dirname as dirname2, join as join2 } from "path";

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
async function readStdinAll() {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin)
    s += chunk;
  return s;
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

// skills/resolve-review-comments/scripts/reply-to-thread.ts
var OUTCOME_HELP = `reply-to-thread.ts: body must begin with an outcome token.

  **accepted**  the finding is real and you fixed it
  **rejected**  the finding is wrong, already handled, or intended
  **wont-fix**  valid but deliberately declined (triage rubric); no follow-up
  **deferred**  real and obligatory but out of scope; a follow-up issue is filed
  **moot**      no longer applies; the anchored code is gone

Write it as the FIRST token of the first line, bold and lowercase, followed by
whitespace and a concrete reason, e.g.

  **accepted** \u2014 added the missing guard; not yet pushed.

The reason is required: a bare token classifies the thread while explaining
nothing, and \`**accepted**oops\` has no token boundary at all. Both would enter
the harvested dataset as a sample with nothing behind it.

These replies are harvested to score the review bot, so the token is a
machine-read contract rather than a formatting habit. For a reply that is
genuinely not an outcome (a clarifying question), pass --no-outcome.`;
function validateOutcomeBody(body) {
  const firstLine = (body.split(`
`, 1)[0] ?? "").replace(/\r$/, "");
  const m = firstLine.match(/^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\*([ \t]+)(.*)$/);
  if (!m)
    return false;
  return /[A-Za-z0-9]/.test(m[3] ?? "");
}
var LEAVE_OPEN_MARKER = "<!-- triage-thread:leave-open -->";
var LEAVE_OPEN_MARKER_PRODUCER_ENV = "DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER";
function hasLeaveOpenMarker(body) {
  const lines = body.split(`
`);
  let i = lines.length - 1;
  while (i >= 0 && lines[i]?.replace(/\r$/, "").trim() === "")
    i--;
  if (i < 0)
    return false;
  return lines[i]?.replace(/\r$/, "") === LEAVE_OPEN_MARKER;
}
var NO_OUTCOME_MARKER = "<!-- reply-to-thread:no-outcome -->";
function hasNoOutcomeMarker(body) {
  const lines = body.split(`
`);
  let i = lines.length - 1;
  while (i >= 0 && lines[i]?.replace(/\r$/, "").trim() === "")
    i--;
  if (i < 0)
    return false;
  return lines[i]?.replace(/\r$/, "") === NO_OUTCOME_MARKER;
}
var DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
var DRIVE_PR_SCRIPTS = join2(DRIVE_PR_ROOT, "scripts");
var ASSERT_POST_ALLOWED = join2(DRIVE_PR_SCRIPTS, "assert-post-allowed.ts");
var SKILLS_ROOT = dirname2(DRIVE_PR_ROOT);
function skillsParentIsIntact(parent = SKILLS_ROOT) {
  try {
    return statSync(parent).isDirectory();
  } catch {
    return false;
  }
}
function assertNoDriveContext() {
  if ((process.env.DRIVE_PR_TARGET ?? "") === "")
    return;
  fail(1, "reply-to-thread: /drive-pr is not installed here, but this process is running", "inside a drive ($DRIVE_PR_TARGET is set):", `  ${DRIVE_PR_ROOT}`, "", "Refusing to post. That variable is exported by /drive-pr's own drive.ts and", "nothing else, so a drive is live against a checkout that no longer carries", "the skill \u2014 the one root-absent state that is NOT the standalone install.", "The lease fence that would answer for it is the file that is missing, so", "skipping it here would reinstate the unfenced POST TASK removed.", "", "Restore /drive-pr in this working tree, or stop the drive before posting.");
}
async function assertPostAllowed() {
  try {
    lstatSync(DRIVE_PR_ROOT);
  } catch (e) {
    const code = e?.code;
    if (code === "ENOENT") {
      if (!skillsParentIsIntact()) {
        fail(1, "reply-to-thread: /drive-pr does not resolve here, and neither does the", "directory it would sit in:", `  ${SKILLS_ROOT}`, "", "Refusing to post. ENOENT on the root says the path does not resolve, not", "WHICH component of it failed \u2014 and a skills/ directory that has been", "removed or renamed underneath this already-loaded process is a damaged", "tree, not the standalone install. It is no evidence that no drive exists,", "so skipping the fence here would be the unfenced POST TASK removed.", "", "Restore the checkout, or re-run once the tree has settled.");
      }
      assertNoDriveContext();
      return;
    }
    fail(1, `reply-to-thread: could not tell whether /drive-pr is installed here (${code ?? String(e)}):`, `  ${DRIVE_PR_ROOT}`, "", "Refusing to post. An indeterminate look at this path is not evidence this", "is the standalone install \u2014 it could be a real /drive-pr this process", "merely could not see, and posting unfenced would be the exact behaviour", "TASK removed.");
  }
  if (!existsSync2(DRIVE_PR_SCRIPTS)) {
    fail(1, `reply-to-thread: /drive-pr's skill directory is present but its scripts are missing:`, `  ${DRIVE_PR_SCRIPTS}`, "", "Refusing to post. This is not the standalone-install case \u2014 the skill root", "exists, so a checkout that stopped mid-way (or a half-finished upgrade)", "is at least as likely as a deliberate standalone install, and posting", "unfenced would be the exact behaviour TASK removed.", "", "Restore /drive-pr fully, or remove it entirely if you mean to run without", "the fence.");
  }
  if (!existsSync2(ASSERT_POST_ALLOWED)) {
    fail(1, `reply-to-thread: /drive-pr is installed here but its lease fence is missing:`, `  ${ASSERT_POST_ALLOWED}`, "", "Refusing to post. A drive may be running in this working tree, and the one", "check that would say so is not there \u2014 so posting would be the unfenced", "behaviour TASK removed, reinstated silently by a broken install.", "", "Restore the file, or remove the /drive-pr skill entirely if you mean to run", "without the fence.");
  }
  const r = await run([
    process.execPath,
    ASSERT_POST_ALLOWED,
    "--what",
    "reply-to-thread.ts (drive lease)"
  ], { timeoutSec: 120, stderr: "inherit" });
  if (r.code === 0)
    return;
  if (r.timedOut) {
    fail(1, "reply-to-thread: the drive-lease fence timed out, so whether another session has taken this tree's drive lease is unknown.", "Refusing to post rather than assume: a reply cannot be withdrawn once it", "is on the thread (TASK).");
  }
  fail(r.code, "reply-to-thread: refusing to post \u2014 see the fence above.");
}
async function main() {
  const argv = process.argv.slice(2);
  const threadId = argv[0] ?? "";
  if (threadId === "") {
    fail(2, "usage: reply-to-thread.ts <thread-node-id> <<'EOF' ... EOF");
  }
  let requireOutcome = true;
  if (argv.length === 2) {
    if (argv[1] === "--no-outcome") {
      requireOutcome = false;
    } else {
      fail(2, "usage: reply-to-thread.ts <thread-node-id> [--no-outcome] <<'EOF' ... EOF (the only allowed 2nd argument is --no-outcome \u2014 the body must come from stdin)");
    }
  } else if (argv.length > 2) {
    fail(2, "usage: reply-to-thread.ts <thread-node-id> [--no-outcome] <<'EOF' ... EOF");
  }
  const body = await readStdinAll();
  if (body === "") {
    fail(2, "usage: reply-to-thread.ts <thread-node-id> [--no-outcome] <<'EOF' ... EOF (stdin body was empty)");
  }
  if (requireOutcome && !validateOutcomeBody(body)) {
    fail(2, OUTCOME_HELP);
  }
  if (hasLeaveOpenMarker(body) && process.env[LEAVE_OPEN_MARKER_PRODUCER_ENV] !== "1") {
    fail(2, `reply-to-thread.ts: this body's own trailing line already matches LEAVE_OPEN_MARKER ('${LEAVE_OPEN_MARKER}') \u2014 refusing to post it.`, "Remove that trailing line, or use triage-thread.ts --leave-open instead \u2014 the only", "sanctioned producer of a reply carrying that marker.");
  }
  if (hasNoOutcomeMarker(body)) {
    fail(2, `reply-to-thread.ts: this body's own trailing line already matches NO_OUTCOME_MARKER ('${NO_OUTCOME_MARKER}') \u2014 refusing to post it.`, "Remove that trailing line \u2014 this script appends it itself when --no-outcome is passed.");
  }
  await assertPostAllowed();
  const postBody = requireOutcome ? body : `${body}

${NO_OUTCOME_MARKER}`;
  const request = JSON.stringify({
    query: "mutation($threadId:ID!, $body:String!){ addPullRequestReviewThreadReply(input:{ pullRequestReviewThreadId:$threadId, body:$body }){ comment{ url } } }",
    variables: { threadId, body: postBody }
  });
  const r = await ghCall([
    "api",
    "graphql",
    "--input",
    "-",
    "-q",
    ".data.addPullRequestReviewThreadReply.comment.url"
  ], { stdin: request, stderr: "inherit" });
  if (r.timedOut) {
    fail(1, "reply-to-thread: gh api graphql killed by the GH_CALL_TIMEOUT deadline");
  }
  if (r.code !== 0)
    return r.code;
  process.stdout.write(r.stdout);
  return 0;
}
if (isEntryPoint(import.meta.url))
  runMain("reply-to-thread", main);
export {
  skillsParentIsIntact,
  validateOutcomeBody
};
