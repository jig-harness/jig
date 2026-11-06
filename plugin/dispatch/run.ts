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
 * the drive ends it records the exit, and an exit of `QUOTA_PARKED` (`16`,
 * a usage-limit wall) writes the account's wall: the reset the drive
 * recorded, else `wall_backoff` from now. The drive's exits are read by
 * name from drive-pr's terminal-state registry (`DRIVE_EXIT`).
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
 * passes its output through, and keeps its last `Question:` line, nothing
 * else of it, on the exit of a pass that ended without recording `done`:
 * that is where a pass that needs a person states its question.
 *
 * A pickup's record starts its vendor's agent instead (Claude Code or
 * Codex), interactively, on `/jig:do-item <key>` with its route's model and
 * effort, bound to its account the same way.
 *
 * Whatever it starts runs with `JIG_LAUNCH` set to the launch record, so
 * `jig send` refuses that session a person's commands
 * (`shared/launched-session.ts`).
 *
 * A Claude follow-up that exits unsuccessfully within a minute, without a
 * result, a question or its own transcript, could not start: its account
 * backs off and its claim is released for retry. A recognized vendor usage
 * notice identifies a quota wall; otherwise its cause stays unknown. An
 * unreadable transcript scan withholds that classification.
 * Once the exit is recorded, the wrapper writes the
 * launch's end onto the shared claim this host made for it (a drive's launch
 * claim, a follow-up's marker; `lib/shared-launches.ts`'s `settleAtExit`), so
 * another host reads the end when the launch ends; a write that fails is one
 * line on its output, and the host's next tick with `--apply` writes the end
 * instead. Then a run that left
 * nothing for a person (a drive whose exit the registry's
 * `driveExitClosesTab` closes on, a session or a follow-up pass that
 * recorded `done`) closes its terminal tab, when the tick recorded it as a
 * run tab (`shared/orca-tabs.ts`); a park or a failure keeps the tab.
 *
 * Exit codes: the drive's own; 2 usage, a token that is not the record's,
 * a state database a newer plugin wrote, or a follow-up whose permission
 * settings do not read; 3 the record was already claimed, so nothing
 * started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { swallow } from "../shared/errors.ts";
import { QuestionTail } from "./lib/question-tail.ts";
import { NO_WATCH, watchWindowsTree } from "./lib/windows-tree.ts";
import { captureIdentity } from "../shared/liveness.ts";
import { endOwnTab, withoutRunTabMarker } from "../shared/orca-tabs.ts";
import { LAUNCH_VARIABLE } from "../shared/launched-session.ts";
import { resolveAccountIdentity } from "../skills/drive-pr/scripts/lib/identity.ts";
import { passCommand } from "../skills/drive-pr/scripts/lib/pass-command.ts";
import {
  DRIVE_EXIT,
  driveExitClosesTab,
} from "../skills/drive-pr/scripts/lib/status/terminal-states.ts";
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
  readEnded,
  readRecord,
  readResult,
  recordExit,
} from "./lib/launches.ts";
import { probeWall } from "./lib/quota-probe.ts";
import { settleAtExit } from "./lib/shared-launches.ts";
import {
  followupPassArgv,
  QUESTION_PREFIX,
  sessionArgv,
} from "./lib/session.ts";
import { failureText } from "./lib/text.ts";
import { configuredPassArgs } from "../skills/drive-pr/scripts/lib/pass-args.ts";
import { StateVersionError } from "./lib/state.ts";
import { writeWall } from "./lib/walls.ts";
import { failedStartup } from "./lib/session-startup.ts";

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

/** How much of a follow-up pass's last `Question:` line its exit keeps. */
const QUESTION_CHARS = 1000;
/** How long a pass stopped at its deadline has to end before it is killed. */
const STOP_GRACE_MS = 10_000;
/** How long the wrapper waits, once the stage exited, for the rest of its output and for its descendants to end. */
const DRAIN_MS = 2000;

interface Ran {
  started?: number;
  exited?: number;
  output?: string;
  code: number | null;
  signal: string | null;
  /** The stage's last `Question:` line, where the wrapper kept it. */
  said?: string;
  /** Windows only: the pass's tree could not be shown to have ended, so no exit is published. */
  unconfirmed?: true;
}

/** How the wrapper runs a stage: whether it keeps its last question, and the deadline it enforces itself (seconds, `0` for none). */
interface RunOptions {
  keepOutput: boolean;
  deadlineSec: number;
}

/** Whether a process group still has a member. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill what is left of a pass's group and wait, briefly, for it to end. */
async function endGroup(
  pid: number | undefined,
  signalTree: (name: NodeJS.Signals) => void,
): Promise<void> {
  if (pid === undefined || !groupAlive(pid)) return;
  signalTree("SIGKILL");
  const gone = Date.now() + DRAIN_MS;
  while (groupAlive(pid) && Date.now() < gone) await Bun.sleep(20);
}

/** The timers that stop a pass at its deadline: a signal, then a kill after the grace. */
function armDeadline(
  deadlineSec: number,
  signalTree: (name: NodeJS.Signals) => void,
  endTree: () => Promise<void>,
): ReturnType<typeof setTimeout>[] {
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (deadlineSec <= 0) return timers;
  timers.push(
    setTimeout(() => {
      console.error(
        `jig dispatch run: the pass ran past its ${deadlineSec}s deadline; stopping it`,
      );
      signalTree("SIGTERM");
      timers.push(
        setTimeout(() => {
          signalTree("SIGKILL");
          void endTree();
        }, STOP_GRACE_MS),
      );
    }, deadlineSec * 1000),
  );
  return timers;
}

/** Wait, briefly, for the last of a pass's output; a pipe a surviving descendant holds open is let go. */
async function drainOutput(
  child: ChildProcess,
  drained: () => boolean,
): Promise<void> {
  const until = Date.now() + DRAIN_MS;
  while (!drained() && Date.now() < until) await Bun.sleep(20);
  if (!drained()) releasePipe(child);
}

/** Let go of a pass's output pipe that a surviving descendant holds open. */
function releasePipe(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stdout?.destroy();
  child.stderr?.removeAllListeners("data");
  child.stderr?.destroy();
}

function runStage(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  options: RunOptions = { keepOutput: false, deadlineSec: 0 },
): Promise<Ran> {
  return new Promise((settle) => {
    const started = Date.now();
    let output = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // A pass under a deadline leads its own process group, so the deadline reaches what the agent started too.
    const grouped = options.deadlineSec > 0 && process.platform !== "win32";
    // Windows has no process group to signal; its tree is walked and ended by identity.
    const treed = options.deadlineSec > 0 && process.platform === "win32";
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      detached: grouped,
      stdio: options.keepOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    const watch = treed
      ? watchWindowsTree(
          child.pid,
          () => child.exitCode === null && child.signalCode === null,
        )
      : NO_WATCH;
    let treeEnded = true;
    const endWindowsTree = async () => {
      treeEnded = await watch.end();
    };
    const signalTree = (name: NodeJS.Signals) => {
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, name);
          return;
        } catch (error) {
          swallow(error, "the pass's group is gone or unsignalable");
        }
      }
      child.kill(name);
    };
    const tail = new QuestionTail(QUESTION_PREFIX, QUESTION_CHARS);
    let drained = !options.keepOutput;
    child.stdout?.on("data", (chunk: Buffer) => {
      output = (output + stdoutDecoder.write(chunk)).slice(-8192);
      if (!process.stdout.write(chunk)) {
        child.stdout?.pause();
        process.stdout.once("drain", () => child.stdout?.resume());
      }
      tail.write(chunk);
    });
    child.stdout?.on("end", () => {
      output = (output + stdoutDecoder.end()).slice(-8192);
      drained = true;
    });
    let stderrDrained = !options.keepOutput;
    child.stderr?.on("data", (chunk: Buffer) => {
      output = (output + stderrDecoder.write(chunk)).slice(-8192);
      if (!process.stderr.write(chunk)) {
        child.stderr?.pause();
        process.stderr.once("drain", () => child.stderr?.resume());
      }
    });
    child.stderr?.on("end", () => {
      output = (output + stderrDecoder.end()).slice(-8192);
      stderrDrained = true;
    });
    const forward = (name: NodeJS.Signals) => signalTree(name);
    for (const name of FORWARDED) process.on(name, forward);
    const timers = armDeadline(options.deadlineSec, signalTree, () =>
      endWindowsTree(),
    );
    let ended = false;
    const done = async (code: number | null, signal: string | null) => {
      if (ended) return;
      ended = true;
      const exited = Date.now();
      for (const timer of timers) clearTimeout(timer);
      watch.stopSampling();
      // What the agent started can outlive it; the exit is published once the group has ended.
      if (grouped) await endGroup(child.pid, signalTree);
      await endWindowsTree();
      for (const name of FORWARDED) process.off(name, forward);
      await drainOutput(child, () => drained && stderrDrained);
      tail.end();
      settle({
        code,
        signal,
        started,
        exited,
        output,
        ...(!treeEnded ? { unconfirmed: true as const } : {}),
        ...(options.keepOutput && tail.question !== ""
          ? { said: tail.question }
          : {}),
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

/** How the wrapper runs a record's stage: a follow-up's pass under its own deadline, its last question kept; anything else as it is. */
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
  if (
    !isDrive(record) ||
    record.pr === null ||
    code !== DRIVE_EXIT.QUOTA_PARKED
  )
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
  const identity = await captureIdentity();
  if (!identity.ok) {
    console.error(`jig dispatch run: ${identity.failure.reason}; not starting`);
    return 2;
  }
  const claim = { ...identity.value, claimedAt: new Date().toISOString() };
  if (!claimRecord(id, claim)) {
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
    await endSharedClaim(id);
    return 2;
  }
  const ran = await runStage(
    argv,
    record.workspace.path,
    // The tab's own command is this wrapper; the drive it runs is not. What
    // it starts is a session the line started, named by its launch record.
    {
      ...withoutRunTabMarker(passEnvironment(process.env, record)),
      [LAUNCH_VARIABLE]: id,
    },
    runOptions(record),
  );
  return finishRun(id, record, ran);
}

/** Startup evidence is checked only when the session left no result or question. */
function startupOf(record: LaunchRecord, ran: Ran) {
  if (
    readResult(record.id) !== null ||
    ran.said ||
    ran.started === undefined ||
    ran.exited === undefined
  )
    return undefined;
  return failedStartup(
    record,
    ran.code,
    ran.started,
    ran.output ?? "",
    ran.exited,
  );
}

/** Back off an account before releasing the slot held by an unstarted session. */
function recordStartupWall(record: LaunchRecord, startup: string): boolean {
  try {
    writeWall({
      account: record.account,
      vendor: record.vendor,
      configDir: record.configDir,
      resetAt: new Date(Date.now() + record.wallBackoffMs).toISOString(),
      source: `session could not start (${startup}); wall_backoff`,
    });
    return true;
  } catch (error) {
    swallow(
      error,
      "the unstarted session's account backoff could not be recorded",
    );
    return false;
  }
}

/** Publish a finished stage's exit, unless its processes may still run. */
async function finishRun(
  id: string,
  record: LaunchRecord,
  ran: Ran,
): Promise<number> {
  const { code, signal } = ran;
  if (ran.unconfirmed) {
    // The pass's processes may still run, so no exit is published. The wrapper then exits, and a record whose wrapper is gone no longer holds its slot: the limit design/dark-factory-dispatch.md records for a Windows tree.
    console.error(
      "jig dispatch run: the pass's process tree could not be shown to have ended; no exit is recorded",
    );
    return code ?? 1;
  }
  // The wall first: once the exit is published the record no longer holds its
  // slot, and a tick in between would admit the walled account.
  const wallUnrecorded = !(await wallRecorded(record, code));
  const startup = startupOf(record, ran);
  const startupWallUnrecorded =
    startup !== undefined && !recordStartupWall(record, startup);
  recordExit(id, {
    at: new Date().toISOString(),
    code,
    signal,
    ...(wallUnrecorded || startupWallUnrecorded
      ? { wallUnrecorded: true as const }
      : {}),
    ...(startup === undefined ? {} : { startup }),
    ...saidOf(record, ran),
  });
  await endSharedClaim(id);
  await closeTabIfDone(record, code);
  return code ?? 1;
}

/**
 * Write the launch's end onto its shared claim, now that its exit is
 * recorded. What could not be written is one line here each, and the next
 * tick writes it; the wrapper's exit stays the stage's.
 */
async function endSharedClaim(id: string): Promise<void> {
  let failures: string[];
  try {
    const ended = readEnded(id);
    failures = ended === null ? [] : await settleAtExit(ended);
  } catch (error) {
    failures = [failureText(error)];
  }
  for (const why of failures)
    console.error(
      `jig dispatch run: the launch's end is not on its claim (${why}); the next tick writes it`,
    );
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
