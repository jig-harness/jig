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
 * of the account's vendor (`claude -p "/jig:drive-pr --bots-only <PR> <pass role>"`, or
 * Codex's `codex exec …`, with the bypass when the record says the tick
 * admitted it on a host that opted in, and the host's `drive.codex_pass_args`
 * the record keeps before the prompt, or `--pass-args ''` on a record that
 * keeps none, so `drive.ts` adds no others) and the deadline the one the
 * tick admitted it under, with the account's configuration directory set (`CLAUDE_CONFIG_DIR`
 * or `CODEX_HOME`) and the credential variables and the other directory
 * variable removed, so the pass bills the account the tick admitted. When
 * the drive ends it records the exit, and an exit of `QUOTA_PARKED` (`16`,
 * a usage-limit wall) writes the account's wall: the reset the drive
 * recorded, else `wall_backoff` from now. The drive's error output passes
 * through the wrapper, which keeps its end: an exit on `drive.ts`'s usage
 * error (`UNSUPPORTED_CLI`) records the drive's message on the exit
 * (`usage`, one bounded line), which the tick tells a person instead of
 * launching the same command again. The drive's exits are read by name from
 * drive-pr's terminal-state registry (`DRIVE_EXIT`).
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
 *   bun … run.ts tracker <slug> <deadline-ms>
 *
 * prints, as JSON, whether the repository's tracker answers in this
 * process's environment and working directory, opened from the
 * configuration on its input (`lib/tracker-probe.ts`); the tick runs it in
 * an account's environment and the repository's checkout before a stage
 * that touches the tracker (`lib/preflight.ts`).
 *
 * A follow-up's record starts a headless pass instead: its vendor's
 * non-interactive command (`claude -p`, `codex exec`) on the repository's
 * follow-up command and the pull request (`lib/session.ts`), bound to its
 * account the same way. A Claude Code pass gets the host's
 * `drive.pass_args`, read here in the workspace as `drive.ts` reads them for
 * a drive's pass, and a Codex pass the bypass only when the record says the
 * tick admitted it on a host that opted in, with the `drive.codex_pass_args`
 * the record keeps; the wrapper adds no permission of its own. The pass
 * runs with background tasks off (`NO_BACKGROUND_TASKS`), as a drive's
 * passes do: it has no next turn to receive their results. The wrapper stops the pass at the deadline the record names,
 * passes its output through and keeps a bounded diagnostic tail. Its last
 * `Question:` line is also kept unless the pass recorded `done`:
 * that is where a pass that needs a person states its question.
 *
 * A pickup's record starts a headless pass the same way, on
 * `/jig:do-item <key>` (`lib/session.ts`), under the pickup's own deadline
 * the record names (`dispatch.pickup_deadline`), its last `Question:` line
 * kept as a follow-up's is. The pass keeps the agent's own model and
 * effort; `do-item` forwards the item's route to the implementer it
 * delegates to. A pickup an earlier release recorded as an interactive
 * session starts its vendor's agent interactively instead, on its route's
 * model and effort.
 *
 * Whatever it starts runs with `JIG_LAUNCH` set to the launch record, so
 * `jig send` refuses that session a person's commands
 * (`shared/launched-session.ts`).
 *
 * A Claude follow-up, steward or pickup pass that exits unsuccessfully
 * within a minute, without a result, a question or its own transcript,
 * could not start: its account is walled, and a follow-up's claim is
 * released for retry. A recognized vendor usage notice identifies a quota
 * wall, which lifts at the reset the notice states (`wall_backoff` from now
 * when that does not read); otherwise its cause stays unknown and the
 * account backs off for `wall_backoff`. An unreadable transcript scan
 * withholds that classification. A failing pass, however long it ran, whose
 * output or transcript ends on the usage notice is a quota wall too.
 * Before it records the exit of a pass that left no closing report, the
 * wrapper records what it saw as the report, `by: wrapper` (a pass that
 * could not start, one it stopped at its deadline, any steward pass), or,
 * for a pickup's or a follow-up's pass it cannot explain, copies the end of
 * its transcript for the steward (`lib/end-report.ts`); a Codex pass's
 * transcript is found by the session id it printed, which the exit keeps.
 * Once the exit is recorded, the wrapper writes the
 * launch's end onto the shared claim this host made for it (a drive's launch
 * claim, a follow-up's marker; `lib/shared-launches.ts`'s `settleAtExit`), so
 * another host reads the end when the launch ends; a write that fails is one
 * line on its output, and the host's next tick with `--apply` writes the end
 * instead. Then, on every exit it recorded (a park and a failure
 * included), the wrapper closes its terminal tab, when the tick recorded it
 * as a run tab (`shared/orca-tabs.ts`): the closing report, or the cause the
 * wrapper, the driver or the steward records, keeps what the tab showed, and
 * a drive's output stays in its driver log. A stage whose exit it could not
 * record keeps the tab until the tick finds the record ended without its
 * wrapper and asks the session runtime to end the run (`endRun`).
 *
 * Once its stage has ended, the wrapper reads and writes its own launch
 * record even when an upgrade during the stage moved the state database past
 * a step that was not additive (`lib/state.ts`'s `enterAfterStage`), so the
 * exit and what follows it are recorded as without the upgrade. A database
 * that refuses it even then (a newer schema without a column it touches)
 * leaves the exit unrecorded: the wrapper says the stage ran and how it
 * ended, and exits with the stage's own code.
 *
 * Exit codes: the stage's own (a drive's exit), also when the state database
 * refuses the wrapper after its stage ran; 2 usage, a token that is not the
 * record's, a state database a newer plugin wrote that refuses the wrapper
 * before its stage starts, so nothing is started, or a follow-up or pickup
 * whose permission settings do not read; 3 the record was already claimed,
 * so nothing started.
 */
import { runStage, type Ran, type RunOptions } from "./lib/run-stage.ts";
import { ownPass, startupOf, startupOutputOf } from "./lib/pass-startup.ts";
import { driverCleanupUncertain } from "./lib/stage-cleanup.ts";
import { runProcessEntry } from "./lib/runtime/process-entry.ts";
import { rememberProcessOwner } from "./lib/runtime/process-owner.ts";
import { removeProcessSpool } from "./lib/runtime/process-spool.ts";
import { spawnSupervisor } from "./lib/spawn-supervisor.ts";
import {
  readStageClaim,
  registerStageProcess,
  uncertainStage,
} from "./lib/launch-supervision.ts";
import { resolve } from "node:path";
import { swallow } from "../shared/errors.ts";
import { passOutput } from "./lib/pass-output.ts";
import { captureIdentity, type ProcessIdentity } from "../shared/liveness.ts";
import { endOwnTab, withoutRunTabMarker } from "../shared/orca-tabs.ts";
import { LAUNCH_VARIABLE } from "../shared/launched-session.ts";
import { resolveAccountIdentity } from "../skills/drive-pr/scripts/lib/identity.ts";
import { harnessNamed } from "../shared/agent-harness/index.ts";
import {
  NO_BACKGROUND_TASKS,
  passCommand,
} from "../skills/drive-pr/scripts/lib/pass-command.ts";
import { DRIVE_EXIT } from "../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { run } from "../shared/proc.ts";
import {
  driveState,
  driveTs,
} from "../skills/drive-pr/scripts/lib/driver/paths.ts";
import { passEnvironment } from "./lib/accounts.ts";
import {
  claimRecord,
  isDrive,
  isInteractive,
  type LaunchRecord,
  readEnded,
  readRecord,
  readResult,
  recordExit,
} from "./lib/launches.ts";
import { quotaMain } from "./lib/quota-probe.ts";
import {
  driverReportFile,
  printKeptReport,
  recordAndSay,
} from "./lib/run-report.ts";
import { DRIVER_REPORT_VARIABLE } from "../shared/driver-report.ts";
import { settleAtExit } from "./lib/shared-launches.ts";
import { followupEndOf, labelFollowupEnd } from "./lib/followup-label.ts";
import { defectLine } from "../shared/pr-labels/write.ts";
import {
  followupPassArgv,
  pickupPassArgv,
  stewardPassArgv,
  sessionArgv,
} from "./lib/session.ts";
import { failureText } from "./lib/text.ts";
import { configuredPassArgs } from "../skills/drive-pr/scripts/lib/pass-args.ts";
import { RESOLVED_PARKS_PR_ENV } from "../skills/drive-pr/scripts/lib/driver/rearm.ts";
import {
  enterAfterStage,
  newerStateRefusal,
  stateDbFailure,
} from "./lib/state.ts";
import { writeUnwritten } from "./lib/unwritten-result.ts";
import { stateRoot } from "./receipts.ts";
import { writeWall } from "./lib/walls.ts";
import { type StartupFailure, startupWall } from "./lib/session-startup.ts";
import { settleUnreported } from "./lib/end-report.ts";
import { currentIso, currentMs, isoFromMs, parseMs } from "../shared/time.ts";

const CLAIMED = 3;

const BUNFIG = resolve(import.meta.dir, "bunfig.toml");

/**
 * The drive command a record starts, under the same trusted startup as this
 * wrapper: the documented pass command of the record's vendor, under the
 * pass deadline and the host's opt-in the record was admitted with. A Codex
 * pass carries the extra words the record keeps; with none, `--pass-args ''`
 * keeps `drive.ts` from adding any it reads later.
 */
function driveCommand(record: LaunchRecord, script: string): string[] {
  const pr = String(record.pr);
  const deadline = record.passTimeoutSec;
  const settleTree =
    record.redrive?.uncleanTree === true ||
    (record.rearmLabel != null && record.facts.includes(", exit 12,"));
  const words = record.codexPassArgs ?? [];
  const pass = passCommand(
    record.vendor,
    pr,
    record.codexBypass === true,
    words,
  );
  const pinned = !readsLaunchArgs(record) && words.length === 0;
  if (settleTree)
    pass[pass.length - 1] +=
      "\nThe original tree holds uncommitted work. Inspect it: commit and push edits that belong to this change, or discard edits only when they are known disposable. Stop if ownership is unclear. Settle the existing tree before reporting convergence.";
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    script,
    pr,
    ...(record.action === "takeover" ? ["--take-over"] : []),
    // A re-arm a person asked for (their request label): a drive stopped on
    // its round budget is granted one more instead of stopping on its first
    // check. The steward's and the tick's re-drives never renew it.
    ...(record.rearmLabel != null ? ["--rearm-budget"] : []),
    "--bots-only",
    ...(settleTree ? ["--settle-worktree"] : []),
    ...(pinned ? ["--pass-args", ""] : []),
    ...(typeof deadline === "number"
      ? ["--pass-timeout", String(deadline)]
      : []),
    "--",
    ...pass,
  ];
}

/** Only a launch bound to a person's re-arm request can clear resolved parks. */
function resolvedParkPr(record: LaunchRecord): string {
  if (
    record.action !== "rearm" ||
    record.rearmLabel == null ||
    typeof record.rearmRequestId !== "number"
  )
    return "";
  return String(record.pr);
}

/** Whether the record's harness reads the host's extra pass words as the pass starts; one that fixed them at admission pins them. */
function readsLaunchArgs(record: LaunchRecord): boolean {
  return harnessNamed(record.vendor)?.capabilities.hostArgsAt !== "admission";
}

/** The drive script: `drive-pr`'s, unless a test names another. */
function driveScript(): string {
  return process.env.JIG_DISPATCH_DRIVE_SCRIPT || driveTs;
}

/** How much of a drive's usage message its exit keeps. */
const USAGE_CHARS = 600;
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
  return reset !== null && parseMs(reset) > nowMs ? reset : null;
}

async function writeAccountWall(
  record: LaunchRecord & { pr: number },
): Promise<void> {
  const now = currentMs();
  const reset = await recordedReset(record.pr, now);
  const path = writeWall({
    account: record.account,
    vendor: record.vendor,
    configDir: record.configDir,
    resetAt: reset ?? isoFromMs(now + record.wallBackoffMs),
    source:
      reset === null
        ? `no reset recorded; wall_backoff from ${isoFromMs(now)}`
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
 * What a record starts: a drive's pass, a follow-up's or a pickup's pass
 * with the host's `drive.pass_args` (read in the workspace, which is the
 * working directory by now), or an interactive pickup an earlier release
 * recorded. Throws when the pass's permission settings do not read.
 */
function stageArgv(record: LaunchRecord): string[] {
  // `drive.pass_args` is Claude Code's: a Codex pass never reads it, so a bad value cannot stop one.
  const claudeWords = (): readonly string[] =>
    readsLaunchArgs(record) ? configuredPassArgs().words : [];
  if (record.action === "steward")
    return stewardPassArgv(record, claudeWords());
  if (isDrive(record)) return driveCommand(record, driveScript());
  if (record.action === "followup")
    return followupPassArgv(record, claudeWords());
  if (!isInteractive(record)) return pickupPassArgv(record, claudeWords());
  return sessionArgv(record);
}

/** How the wrapper runs a record's stage: its own pass under its deadline, its last question kept; a drive with the end of its error output kept; anything else as it is. */
function runOptions(record: LaunchRecord): RunOptions {
  if (!ownPass(record))
    return {
      keepOutput: isDrive(record),
      keepErrors: isDrive(record),
      deadlineSec: 0,
    };
  const deadline = record.passTimeoutSec;
  return {
    keepOutput: true,
    deadlineSec: typeof deadline === "number" ? deadline : 0,
  };
}

/** Keep bounded diagnostic output independently of whether a pass asked a question. */
function saidOf(
  record: LaunchRecord,
  ran: Ran,
): { said?: string; context?: string } {
  return passOutput(ran, readResult(record.id), record.token);
}

/**
 * The drive's message on an exit on its usage error: from the last line its
 * output starts with `drive.ts` (where `drive.ts` states a refusal), else its
 * last lines, joined into one line and bounded.
 */
function usageOf(
  record: Pick<LaunchRecord, "action">,
  ran: Pick<Ran, "code" | "errors">,
): { usage?: string } {
  if (!isDrive(record) || ran.code !== DRIVE_EXIT.UNSUPPORTED_CLI) return {};
  const lines = (ran.errors ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
  let from = lines.length - 3;
  for (const [i, line] of lines.entries())
    if (line.startsWith("drive.ts")) from = i;
  const said = lines.slice(Math.max(0, from)).join(" ");
  if (said === "") return {};
  return {
    usage:
      said.length > USAGE_CHARS ? `${said.slice(0, USAGE_CHARS - 1)}…` : said,
  };
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

/** A wrapper or supervisor must publish ownership before starting its stage. */
async function publishOwner(record: LaunchRecord, identity: ProcessIdentity) {
  const written = await rememberProcessOwner(record, identity);
  if (written.ok) return true;
  console.error(`jig dispatch run: ${written.failure.reason}`);
  recordExit(record.id, {
    at: currentIso(),
    code: 3,
    signal: null,
    beforeStage: true,
  });
  await endSharedClaim(record.id);
  return false;
}

async function finishWrapper(record: LaunchRecord): Promise<void> {
  if (record.runtime === "process") {
    try {
      if (readEnded(record.id)?.report != null) removeProcessSpool(record.id);
    } catch (error) {
      swallow(error, "the run's output spool stays for inspection");
    }
  } else await closeTabOnExit(record.id);
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
  const identity = await captureIdentity(
    process.pid,
    record.runtime === "process",
  );
  if (!identity.ok) {
    console.error(`jig dispatch run: ${identity.failure.reason}; not starting`);
    return 2;
  }
  const claim = {
    ...identity.value,
    claimedAt: currentIso(),
    ...(!isInteractive(record)
      ? { supervision: { supervisor: null, child: null } }
      : {}),
  };
  if (!claimRecord(id, claim)) {
    console.error(
      `jig dispatch run: ${id} is already claimed; nothing started`,
    );
    if (record.runtime !== "process") await closeRefusedTab();
    return CLAIMED;
  }
  if (!(await publishOwner(record, identity.value))) return 3;
  process.chdir(record.workspace.path);
  let code: number;
  if (isInteractive(record)) {
    code = await executeStage(id, record);
  } else {
    code = await spawnSupervisor(id, token, record.runtime === "process");
    enterAfterStage();
  }
  await finishWrapper(record);
  return code;
}

/**
 * Whether the supervisor recorded the stage's exit. A state database that
 * refuses this wrapper reads as no exit: the supervisor has already said why,
 * and the tab stays for a person.
 */
function supervisedEnded(id: string): boolean {
  try {
    return readEnded(id)?.state.kind === "ended";
  } catch (error) {
    if (newerStateRefusal(error) === null) throw error;
    return false;
  }
}

async function executeStage(
  id: string,
  record: LaunchRecord,
  owner?: RunOptions["owner"],
): Promise<number> {
  if (record.workspace === null) return 2;
  let argv: string[];
  try {
    argv = stageArgv(record);
  } catch (error) {
    console.error(`jig dispatch run: ${failureText(error)}; not starting`);
    recordExit(id, { at: currentIso(), code: 2, signal: null });
    await endSharedClaim(id);
    return 2;
  }
  const ran = await runStage(
    argv,
    record.workspace.path,
    // The tab's own command is this wrapper; the drive it runs is not. What
    // it starts is a session the line started, named by its launch record.
    // A pass of its own starts no background task, as a drive's passes do.
    {
      ...withoutRunTabMarker(passEnvironment(process.env, record)),
      ...(ownPass(record) ? NO_BACKGROUND_TASKS : {}),
      [LAUNCH_VARIABLE]: id,
      [RESOLVED_PARKS_PR_ENV]: resolvedParkPr(record),
      JIG_OUTBOUND_CALLER: `pass:${record.action}:${record.id}`,
      ...(isDrive(record)
        ? { [DRIVER_REPORT_VARIABLE]: driverReportFile(id) }
        : {}),
    },
    { ...runOptions(record), ...(owner === undefined ? {} : { owner }) },
  );
  return finishRun(id, record, ran);
}

/** A separate process owns the stage and its exit, surviving wrapper death to stop it. */
async function supervise(id: string, token: string): Promise<number> {
  const record = readRecord(id);
  const wrapper = readStageClaim(id, token);
  if (
    record === null ||
    record.token !== token ||
    record.workspace === null ||
    !wrapper?.supervision
  )
    return 2;
  const identity = await captureIdentity(
    process.pid,
    record.runtime === "process",
  );
  if (!identity.ok) {
    console.error(identity.failure.reason);
    return 2;
  }
  const registered = registerStageProcess(
    id,
    token,
    "supervisor",
    identity.value,
    wrapper,
  );
  if (!registered.ok) {
    swallow(registered.failure.cause, registered.failure.reason);
    console.error(registered.failure.reason);
    return 3;
  }
  if (!(await publishOwner(record, identity.value))) return 3;
  process.chdir(record.workspace.path);
  return executeStage(id, record, {
    id,
    token,
    wrapper,
    supervisor: identity.value,
    ...(record.runtime === "process"
      ? { remember: (child) => rememberProcessOwner(record, child) }
      : {}),
  });
}

/** The session id a pass printed at its start (Codex's); Claude Code's is the one the tick minted (`sessionId`). */
function sessionOf(record: LaunchRecord, ran: Ran): string | null {
  const harness = harnessNamed(record.vendor);
  return harness?.capabilities.sessionId === "printed" && ownPass(record)
    ? harness.sessionIdIn(ran.head)
    : null;
}

/**
 * Wall an account before releasing the slot held by a pass that stopped on
 * its account (`startupWall`). The notice is read before the write, so only
 * the write's failure is the wall's to absorb.
 */
function recordStartupWall(
  record: LaunchRecord,
  startup: string,
  output: string,
): boolean {
  const wall = startupWall(record, startup, output, currentMs());
  try {
    writeWall(wall);
    return true;
  } catch (error) {
    swallow(
      error,
      "the unstarted session's account backoff could not be recorded",
    );
    return false;
  }
}

/** Keep the wrapper's explanation or transcript before publishing the exit. */
function settlePassReport(
  record: LaunchRecord,
  ran: Ran,
  startup: StartupFailure | undefined,
  session: string | null,
): void {
  settleUnreported(
    record,
    {
      code: ran.code,
      signal: ran.signal,
      ...(startup === undefined ? {} : { startup }),
      timedOut: ran.timedOut === true,
      ...(startup === "sign-in" || ran.output === undefined
        ? {}
        : { output: ran.output }),
    },
    record.sessionId ?? session,
  );
}

/** Publish the report and exit together, preserving evidence if the state store fails. */
function recordFinishedExit(
  id: string,
  record: LaunchRecord,
  ran: Ran,
  wallUnrecorded: boolean,
): void {
  const { code, signal } = ran;
  try {
    // Every read of the state database sits inside the boundary that keeps the
    // exit evidence, so a database that refuses reads still leaves it.
    const { startup, phrase } = startupOf(record, ran);
    const startupWallUnrecorded =
      startup !== undefined &&
      !recordStartupWall(record, startup, startupOutputOf(ran));
    // The report before the exit: a tick that reads the exit reads its report too.
    recordAndSay(id, record.action, startup, startupWallUnrecorded);
    const session = sessionOf(record, ran);
    settlePassReport(record, ran, startup, session);
    recordExit(id, {
      at: currentIso(),
      code,
      signal,
      ...(wallUnrecorded || startupWallUnrecorded
        ? { wallUnrecorded: true as const }
        : {}),
      ...(startup === undefined ? {} : { startup }),
      ...(phrase === undefined ? {} : { signInPhrase: phrase }),
      ...(session === null ? {} : { session }),
      ...(startup === "sign-in" ? {} : saidOf(record, ran)),
      ...usageOf(record, ran),
    });
  } catch (error) {
    const why = stateDbFailure(error);
    if (!isDrive(record) && why !== null)
      writeUnwritten(stateRoot(), id, record.token, "exit", why);
    throw error;
  }
}

/**
 * Publish a finished stage's exit and what follows it. A state database that
 * refuses this wrapper even past its stage (`enterAfterStage`) is said here,
 * as a stage that ran: the wrapper's exit stays the stage's.
 */
async function finishRun(
  id: string,
  record: LaunchRecord,
  ran: Ran,
): Promise<number> {
  enterAfterStage();
  try {
    return await publishEnd(id, record, ran);
  } catch (error) {
    const newer = newerStateRefusal(error);
    if (newer === null) throw error;
    console.error(
      `jig dispatch run: the stage ran and ended (${endOf(ran)}), and its exit is not recorded: ${newer}`,
    );
    return ran.code ?? 1;
  }
}

/** How a stage ended, as one phrase. */
function endOf(ran: Pick<Ran, "code" | "signal">): string {
  if (ran.code !== null) return `exit ${ran.code}`;
  return ran.signal === null ? "without a code" : `signal ${ran.signal}`;
}

/** Publish a finished stage's exit, unless its processes may still run. */
async function publishEnd(
  id: string,
  record: LaunchRecord,
  ran: Ran,
): Promise<number> {
  const { code } = ran;
  if (ran.unconfirmed || (await driverCleanupUncertain(record, ran))) {
    uncertainStage(id);
    // Unconfirmed cleanup keeps the account slot until reconciliation or clearance.
    console.error(
      "jig dispatch run: the pass's process tree could not be shown to have ended; no exit is recorded",
    );
    // The driver's report is kept all the same: it never touches the exit.
    if (isDrive(record)) {
      recordAndSay(id, record.action, undefined);
      printKeptReport(id);
    }
    return code ?? 1;
  }
  // The wall first: once the exit is published the record no longer holds its
  // slot, and a tick in between would admit the walled account.
  const wallUnrecorded = !(await wallRecorded(record, code));
  recordFinishedExit(id, record, ran, wallUnrecorded);
  await endSharedClaim(id);
  await labelFollowup(id);
  printKeptReport(id);
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

/**
 * A follow-up's end as its pull request's state label, now that its exit is
 * recorded: best effort, one line here when it is not written, and the next
 * tick corrects it; the wrapper's exit stays the stage's.
 */
async function labelFollowup(id: string): Promise<void> {
  let line: string | null;
  let target = `the follow-up of launch record ${id}`;
  try {
    const ended = readEnded(id);
    const outcome = ended === null ? null : followupEndOf(ended);
    if (ended === null || outcome === null || ended.record.pr === null) return;
    target = `PR #${ended.record.pr}`;
    const label = await labelFollowupEnd({
      slug: ended.record.repo,
      pr: ended.record.pr,
      outcome,
    });
    line = label.line;
  } catch (error) {
    line = defectLine(target, error);
  }
  if (line !== null) console.error(`jig dispatch run: ${line}`);
}

/**
 * Close the run's tab once its exit is recorded, whatever the exit: the
 * closing report, or the cause the wrapper, the driver or the steward
 * records, holds what a person read the tab for. A stage whose exit is not
 * recorded (its processes may still run), or that ended on a wall that could
 * not be recorded (a person clears it), keeps the tab, which the tick's
 * `endRun` closes once the record reads as ended. A failure only says so.
 */
async function closeTabOnExit(id: string): Promise<void> {
  let ended: boolean;
  try {
    ended = supervisedEnded(id);
  } catch (error) {
    console.error(
      `jig dispatch run: the run's tab stays open: its exit did not read (${failureText(error)})`,
    );
    return;
  }
  if (!ended) return;
  try {
    const line = await endOwnTab(true);
    if (line !== null) console.error(`jig dispatch run: ${line}`);
  } catch (error) {
    swallow(error, "the run's tab could not be closed");
  }
}

/** `run.ts tracker <slug> <deadline-ms>`: the tracker preflight's answer, the configuration read from the input. */
async function trackerMain(slug: string, deadline: string): Promise<number> {
  const deadlineMs = Number(deadline);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    console.error(
      `jig dispatch run: ${deadline} is not a deadline in milliseconds`,
    );
    return 2;
  }
  // Loaded only here: the wrapper itself never opens a tracker.
  const { answerText, reachTracker } = await import("./lib/tracker-probe.ts");
  let values: unknown;
  try {
    values = JSON.parse(await Bun.stdin.text());
  } catch (error) {
    // The tick's own handing over failed: that says nothing of the account's credential.
    console.log(
      JSON.stringify({
        ok: false,
        kind: "config",
        reason: `the configuration on the input did not read: ${answerText(error)}`,
      }),
    );
    return 0;
  }
  console.log(
    JSON.stringify(await reachTracker(values, slug, process.cwd(), deadlineMs)),
  );
  return 0;
}

/** `run.ts identity <harness>`: the account the named harness reads in this environment. */
function identityMain(name: string): number {
  const harness = harnessNamed(name);
  const read = () => harness?.accountIdentity(process.env);
  console.log(JSON.stringify(read() ?? resolveAccountIdentity([name])));
  return 0;
}

/** The wrapper's command line; `jig dispatch run` reaches it too. */
export async function runMain(argv: string[]): Promise<number> {
  if (argv[0] === "identity" && argv.length === 2)
    return identityMain(argv[1] as string);
  if (argv[0] === "quota" && (argv.length === 4 || argv.length === 5))
    return quotaMain(argv.slice(1));
  if (argv[0] === "tracker" && argv.length === 3)
    return trackerMain(argv[1] as string, argv[2] as string);
  const supervising = argv[0] === "supervise" && argv.length === 3;
  if (!supervising && argv.length !== 2) {
    console.error(
      "usage: run.ts <record> <token> | run.ts identity <harness> | run.ts quota <session-id> <cwd> <since> | run.ts tracker <slug> <deadline-ms>",
    );
    return 2;
  }
  try {
    return supervising
      ? await supervise(argv[1] as string, argv[2] as string)
      : await wrap(argv[0] as string, argv[1] as string);
  } catch (error) {
    // A state database a newer plugin wrote, refusing the wrapper before its
    // stage starts: nothing is started. Past the stage, `finishRun` says it.
    const newer = newerStateRefusal(error);
    if (newer === null) throw error;
    console.error(`jig dispatch run: ${newer}`);
    return 2;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exitCode =
    args[0] === "process-entry" && args.length === 4
      ? await runProcessEntry(
          args[1] as string,
          args[2] as string,
          args[3] as string,
        )
      : await runMain(args);
}
