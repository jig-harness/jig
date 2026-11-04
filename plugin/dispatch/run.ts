/**
 * The wrapper a dispatched headless pass runs in its terminal:
 *
 *   bun --no-env-file --config=<plugin>/dispatch/bunfig.toml \
 *     <plugin>/dispatch/run.ts <record> <token>
 *
 * It claims its launch record atomically, so a second terminal started for
 * a record already claimed (a launch retried under the same record) exits
 * without starting anything. It then starts
 * `drive.ts <PR> [--take-over] --bots-only --pass-timeout <s> -- <pass>` in
 * the pull request's workspace, the pass being the documented pass command
 * of the account's vendor (`claude -p "/jig:drive-pr --bots-only <PR>"`, or
 * Codex's `codex exec …`, with the bypass when the record says the tick
 * admitted it on a host that opted in) and the deadline the one the tick
 * admitted it under, with the account's configuration directory set (`CLAUDE_CONFIG_DIR`
 * or `CODEX_HOME`) and the credential variables and the other directory
 * variable removed, so the pass bills the account the tick admitted. When
 * the drive ends it records the exit, and an
 * exit `16` (a usage-limit wall) writes the account's wall: the reset the
 * drive recorded, else `wall_backoff` from now.
 *
 *   bun … run.ts identity claude|codex
 *
 * prints the account identity the drive's own resolver reads in this
 * process's environment; the tick runs it in the wrapper's environment
 * before a launch.
 *
 *   bun … run.ts quota <session-id> <cwd> <since>
 *
 * prints, as JSON, the usage-limit wall the interactive session
 * `<session-id>` met since `<since>`, read with the drive's quota adapters
 * from the configuration directory in this process's environment, or
 * `null` (`lib/quota-probe.ts`); the tick runs it in the session's
 * account's environment.
 *
 * A follow-up's record starts a headless pass instead: its vendor's
 * non-interactive command (`claude -p`, `codex exec`) on the repository's
 * follow-up command and the pull request (`lib/session.ts`), bound to its
 * account the same way. A Claude Code pass gets the host's
 * `drive.pass_args`, read here in the workspace as `drive.ts` reads them for
 * a drive's pass, and a Codex pass the bypass only when the record says the
 * tick admitted it on a host that opted in; the wrapper adds no permission
 * of its own. The wrapper stops the pass at the deadline the record names,
 * passes its output through, and keeps the output's end on the exit of a
 * pass that ended without recording `done`: that is where a pass that
 * needs a person states its question.
 *
 * A pickup's record starts its vendor's agent instead (Claude Code or
 * Codex), interactively, on `/jig:do-item <key>` with its route's model and
 * effort, bound to its account the same way.
 *
 * The exit of a follow-up's pass or a pickup's session is recorded, and no
 * wall is written for it. Once the exit is recorded, a run that left
 * nothing for a person (a drive whose exit `driveExitClosesTab` closes on, a
 * session or a follow-up pass that recorded `done`) closes its terminal
 * tab, when the tick recorded it as a run tab (`shared/orca-tabs.ts`); a
 * park or a failure keeps the tab.
 *
 * Exit codes: the drive's own; 2 usage, a token that is not the record's,
 * a state database a newer plugin wrote, or a follow-up whose permission
 * settings do not read; 3 the record was already claimed, so nothing
 * started.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { swallow } from "../shared/errors.ts";
import {
  driveExitClosesTab,
  endOwnTab,
  withoutRunTabMarker,
} from "../shared/orca-tabs.ts";
import { resolveAccountIdentity } from "../skills/drive-pr/scripts/lib/identity.ts";
import { passCommand } from "../skills/drive-pr/scripts/lib/pass-command.ts";
import { run } from "../shared/proc.ts";
import {
  driveState,
  driveTs,
} from "../skills/drive-pr/scripts/lib/driver/paths.ts";
import { passEnvironment } from "./lib/accounts.ts";
import {
  claimRecord,
  isDrive,
  type LaunchRecord,
  ownIdentity,
  readRecord,
  readResult,
  recordExit,
} from "./lib/launches.ts";
import { probeWall } from "./lib/quota-probe.ts";
import { followupPassArgv, sessionArgv } from "./lib/session.ts";
import { failureText } from "./lib/text.ts";
import { configuredPassArgs } from "../skills/drive-pr/scripts/lib/pass-args.ts";
import { StateVersionError } from "./lib/state.ts";
import { writeWall } from "./lib/walls.ts";

/** `drive.ts`'s exit for a usage-limit wall it cannot wait out. */
const QUOTA_PARKED = 16;
const CLAIMED = 3;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const BUNFIG = resolve(import.meta.dir, "bunfig.toml");

/**
 * The drive command a record starts, under the same trusted startup as this
 * wrapper: the documented pass command of the record's vendor, under the
 * pass deadline and the host's opt-in the record was admitted with.
 */
function driveCommand(record: LaunchRecord, script: string): string[] {
  const pr = String(record.pr);
  const deadline = record.passTimeoutSec;
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    script,
    pr,
    ...(record.action === "takeover" ? ["--take-over"] : []),
    "--bots-only",
    ...(typeof deadline === "number"
      ? ["--pass-timeout", String(deadline)]
      : []),
    "--",
    ...passCommand(record.vendor, pr, record.codexBypass === true),
  ];
}

/** The drive script: `drive-pr`'s, unless a test names another. */
function driveScript(): string {
  return process.env.JIG_DISPATCH_DRIVE_SCRIPT || driveTs;
}

/** How much of the end of a follow-up pass's output its exit keeps. */
const SAID_CHARS = 2000;
/** How long a pass stopped at its deadline has to end before it is killed. */
const STOP_GRACE_MS = 10_000;
/** How long the wrapper waits, once the stage exited, for the rest of its output. */
const DRAIN_MS = 2000;

interface Ran {
  code: number | null;
  signal: string | null;
  /** The end of the stage's output, where the wrapper kept it. */
  said?: string;
}

/** How the wrapper runs a stage: whether it keeps its output's end, and the deadline it enforces itself (seconds, `0` for none). */
interface RunOptions {
  keepOutput: boolean;
  deadlineSec: number;
}

function runStage(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  options: RunOptions = { keepOutput: false, deadlineSec: 0 },
): Promise<Ran> {
  return new Promise((settle) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      stdio: options.keepOutput ? ["inherit", "pipe", "inherit"] : "inherit",
    });
    let said = "";
    let drained = !options.keepOutput;
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      said = (said + chunk.toString("utf8")).slice(-SAID_CHARS);
    });
    child.stdout?.on("end", () => {
      drained = true;
    });
    const forward = (name: NodeJS.Signals) => child.kill(name);
    for (const name of FORWARDED) process.on(name, forward);
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (options.deadlineSec > 0)
      timers.push(
        setTimeout(() => {
          console.error(
            `jig dispatch run: the pass ran past its ${options.deadlineSec}s deadline; stopping it`,
          );
          child.kill("SIGTERM");
          timers.push(setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS));
        }, options.deadlineSec * 1000),
      );
    let ended = false;
    const done = async (code: number | null, signal: string | null) => {
      if (ended) return;
      ended = true;
      for (const timer of timers) clearTimeout(timer);
      for (const name of FORWARDED) process.off(name, forward);
      // The output's last bytes can follow the exit; a grandchild that keeps the pipe open is not waited for.
      const until = Date.now() + DRAIN_MS;
      while (!drained && Date.now() < until) await Bun.sleep(20);
      settle({
        code,
        signal,
        ...(options.keepOutput ? { said } : {}),
      });
    };
    child.on("error", (error) => {
      console.error(`jig dispatch run: ${error.message}`);
      void done(127, null);
    });
    child.on("exit", (code, signal) => void done(code, signal));
  });
}

/** The reset in the drive state's quota park, read under the same trusted startup as the drive: the state script runs in the consumer's workspace. */
async function parkedReset(pr: number): Promise<string | null> {
  const done = await run(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      driveState,
      "get",
      String(pr),
    ],
    { stderr: "pipe", timeoutSec: 120 },
  );
  if (done.code !== 0) return null;
  try {
    const state: unknown = JSON.parse(done.stdout);
    const park = (state as { quotaPark?: { resetAt?: unknown } } | null)
      ?.quotaPark;
    return typeof park?.resetAt === "string" ? park.resetAt : null;
  } catch (error) {
    swallow(error, "drive-state.ts get printed no JSON");
    return null;
  }
}

/** The reset the drive recorded for its park, when it is still ahead. */
async function recordedReset(
  pr: number,
  nowMs: number,
): Promise<string | null> {
  const reset = await parkedReset(pr);
  return reset !== null && Date.parse(reset) > nowMs ? reset : null;
}

async function writeAccountWall(
  record: LaunchRecord & { pr: number },
): Promise<void> {
  const now = Date.now();
  const reset = await recordedReset(record.pr, now);
  const path = writeWall({
    account: record.account,
    vendor: record.vendor,
    configDir: record.configDir,
    resetAt: reset ?? new Date(now + record.wallBackoffMs).toISOString(),
    source:
      reset === null
        ? `no reset recorded; wall_backoff from ${new Date(now).toISOString()}`
        : `the drive's quota park on PR #${record.pr}`,
  });
  console.error(`jig dispatch run: ${record.account} is walled (${path})`);
}

/** Whether the account's wall was recorded; a failure is the exit's to carry, not a reason to lose the exit. */
async function tryWriteWall(
  record: LaunchRecord & { pr: number },
): Promise<boolean> {
  try {
    await writeAccountWall(record);
    return true;
  } catch (error) {
    swallow(error, `the wall of ${record.account} could not be recorded`);
    return false;
  }
}

/**
 * What a record starts: a drive's pass, a follow-up's pass with the host's
 * `drive.pass_args` (read in the workspace, which is the working directory
 * by now), or a pickup's interactive session. Throws when the follow-up's
 * permission settings do not read.
 */
function stageArgv(record: LaunchRecord): string[] {
  if (isDrive(record)) return driveCommand(record, driveScript());
  if (record.action === "followup")
    return followupPassArgv(record, configuredPassArgs().words);
  return sessionArgv(record);
}

/** How the wrapper runs a record's stage: a follow-up's pass under its own deadline, its output's end kept; anything else as it is. */
function runOptions(record: LaunchRecord): RunOptions {
  if (record.action !== "followup")
    return { keepOutput: false, deadlineSec: 0 };
  const deadline = record.passTimeoutSec;
  return {
    keepOutput: true,
    deadlineSec: typeof deadline === "number" ? deadline : 0,
  };
}

/** The end of a follow-up pass's output, kept on its exit when it ended without recording done. */
function saidOf(record: LaunchRecord, ran: Ran): { said?: string } {
  const said = ran.said?.trim() ?? "";
  if (said === "" || readResult(record.id) === "done") return {};
  return { said };
}

/** Whether a drive that stopped on its account's wall had that wall recorded; true when there was none to record. */
async function wallRecorded(
  record: LaunchRecord,
  code: number | null,
): Promise<boolean> {
  if (!isDrive(record) || record.pr === null || code !== QUOTA_PARKED)
    return true;
  return tryWriteWall({ ...record, pr: record.pr });
}

/** The terminal a refusing wrapper was opened in has nothing to show a person: close it. */
async function closeRefusedTab(): Promise<void> {
  try {
    const line = await endOwnTab(true);
    if (line !== null) console.error(`jig dispatch run: ${line}`);
  } catch (error) {
    swallow(error, "the refusing wrapper's tab could not be closed");
  }
}

async function wrap(id: string, token: string): Promise<number> {
  const record = readRecord(id);
  if (record === null || record.token !== token) {
    console.error(
      `jig dispatch run: ${id} is not a launch record with that token`,
    );
    return 2;
  }
  if (record.workspace === null) {
    console.error(`jig dispatch run: ${id} names no workspace`);
    return 2;
  }
  const identity = await ownIdentity();
  if (identity === null) {
    console.error(
      "jig dispatch run: the process table cannot be read; not starting",
    );
    return 2;
  }
  if (!claimRecord(id, identity)) {
    console.error(
      `jig dispatch run: ${id} is already claimed; nothing started`,
    );
    await closeRefusedTab();
    return CLAIMED;
  }
  process.chdir(record.workspace.path);
  let argv: string[];
  try {
    argv = stageArgv(record);
  } catch (error) {
    console.error(`jig dispatch run: ${failureText(error)}; not starting`);
    recordExit(id, { at: new Date().toISOString(), code: 2, signal: null });
    return 2;
  }
  const ran = await runStage(
    argv,
    record.workspace.path,
    // The tab's own command is this wrapper; the drive it runs is not.
    withoutRunTabMarker(passEnvironment(process.env, record)),
    runOptions(record),
  );
  const { code, signal } = ran;
  // The wall first: once the exit is published the record no longer holds its
  // slot, and a tick in between would admit the walled account.
  const wallUnrecorded = !(await wallRecorded(record, code));
  recordExit(id, {
    at: new Date().toISOString(),
    code,
    signal,
    ...(wallUnrecorded ? { wallUnrecorded: true as const } : {}),
    ...saidOf(record, ran),
  });
  await closeTabIfDone(record, code);
  return code ?? 1;
}

/** Close the run's tab when the run left nothing for a person; a failure only says so. */
async function closeTabIfDone(
  record: LaunchRecord,
  code: number | null,
): Promise<void> {
  try {
    const done = isDrive(record)
      ? driveExitClosesTab(code)
      : readResult(record.id) === "done";
    const line = await endOwnTab(done);
    if (line !== null) console.error(`jig dispatch run: ${line}`);
  } catch (error) {
    swallow(error, "the run's tab could not be closed");
  }
}

/** The wrapper's command line; `jig dispatch run` reaches it too. */
export async function runMain(argv: string[]): Promise<number> {
  if (argv[0] === "identity" && argv.length === 2) {
    console.log(JSON.stringify(resolveAccountIdentity([argv[1] as string])));
    return 0;
  }
  if (argv[0] === "quota" && argv.length === 4) {
    const [, session, cwd, since] = argv as [string, string, string, string];
    if (!Number.isFinite(Date.parse(since))) {
      console.error(`jig dispatch run: ${since} is not a date`);
      return 2;
    }
    console.log(
      JSON.stringify(probeWall(session, cwd, new Date(since), new Date())),
    );
    return 0;
  }
  if (argv.length !== 2) {
    console.error(
      "usage: run.ts <record> <token> | run.ts identity claude|codex | run.ts quota <session-id> <cwd> <since>",
    );
    return 2;
  }
  try {
    return await wrap(argv[0] as string, argv[1] as string);
  } catch (error) {
    // A state database a newer plugin wrote: nothing is started.
    if (!(error instanceof StateVersionError)) throw error;
    console.error(`jig dispatch run: ${error.message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runMain(process.argv.slice(2));
