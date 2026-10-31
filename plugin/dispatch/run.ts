/**
 * The wrapper a dispatched headless pass runs in its terminal:
 *
 *   bun --no-env-file --config=<plugin>/dispatch/bunfig.toml \
 *     <plugin>/dispatch/run.ts <record> <token>
 *
 * It claims its launch record atomically, so a second terminal started for
 * a record already claimed (a launch retried under the same record) exits
 * without starting anything. It then starts
 * `drive.ts <PR> [--take-over] --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"`
 * in the pull request's workspace, with the account's configuration
 * directory set and the credential variables removed, so the pass bills the
 * account the tick admitted. When the drive ends it records the exit, and an
 * exit `16` (a usage-limit wall) writes the account's wall: the reset the
 * drive recorded, else `wall_backoff` from now.
 *
 *   bun … run.ts identity claude|codex
 *
 * prints the account identity the drive's own resolver reads in this
 * process's environment; the tick runs it in the wrapper's environment
 * before a launch.
 *
 * Exit codes: the drive's own; 2 usage or a token that is not the record's;
 * 3 the record was already claimed, so nothing started.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { swallow } from "../shared/errors.ts";
import { resolveAccountIdentity } from "../skills/drive-pr/scripts/lib/identity.ts";
import { readDriveState } from "../skills/drive-pr/scripts/lib/driver/rearm.ts";
import { driveTs } from "../skills/drive-pr/scripts/lib/driver/paths.ts";
import { passEnvironment } from "./lib/accounts.ts";
import {
  claimRecord,
  type LaunchRecord,
  ownIdentity,
  readRecordFile,
  recordExit,
} from "./lib/launches.ts";
import { writeWall } from "./lib/walls.ts";

/** `drive.ts`'s exit for a usage-limit wall it cannot wait out. */
const QUOTA_PARKED = 16;
const CLAIMED = 3;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const BUNFIG = resolve(import.meta.dir, "bunfig.toml");

/** The drive command a record starts, under the same trusted startup as this wrapper. */
function driveCommand(record: LaunchRecord, script: string): string[] {
  const pr = String(record.pr);
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    script,
    pr,
    ...(record.action === "takeover" ? ["--take-over"] : []),
    "--bots-only",
    "--",
    "claude",
    "-p",
    `/jig:drive-pr --bots-only ${pr}`,
  ];
}

/** The drive script: `drive-pr`'s, unless a test names another. */
function driveScript(): string {
  return process.env.JIG_DISPATCH_DRIVE_SCRIPT || driveTs;
}

function runDrive(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((settle) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      stdio: "inherit",
    });
    const forward = (name: NodeJS.Signals) => child.kill(name);
    for (const name of FORWARDED) process.on(name, forward);
    const done = (code: number | null, signal: string | null) => {
      for (const name of FORWARDED) process.off(name, forward);
      settle({ code, signal });
    };
    child.on("error", (error) => {
      console.error(`jig dispatch run: ${error.message}`);
      done(127, null);
    });
    child.on("exit", (code, signal) => done(code, signal));
  });
}

/** The reset the drive recorded for its park, when it is still ahead. */
async function recordedReset(
  pr: number,
  nowMs: number,
): Promise<string | null> {
  const state = await readDriveState(String(pr));
  const reset = state?.quotaPark?.resetAt ?? null;
  return reset !== null && Date.parse(reset) > nowMs ? reset : null;
}

async function writeAccountWall(record: LaunchRecord): Promise<void> {
  const now = Date.now();
  const reset = await recordedReset(record.pr, now);
  const path = writeWall({
    account: record.account,
    resetAt: reset ?? new Date(now + record.wallBackoffMs).toISOString(),
    source:
      reset === null
        ? `no reset recorded; wall_backoff from ${new Date(now).toISOString()}`
        : `the drive's quota park on PR #${record.pr}`,
  });
  console.error(`jig dispatch run: ${record.account} is walled (${path})`);
}

/** Whether the account's wall was recorded; a failure is the exit's to carry, not a reason to lose the exit. */
async function tryWriteWall(record: LaunchRecord): Promise<boolean> {
  try {
    await writeAccountWall(record);
    return true;
  } catch (error) {
    swallow(error, `the wall of ${record.account} could not be recorded`);
    return false;
  }
}

async function wrap(id: string, token: string): Promise<number> {
  const record = readRecordFile(id);
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
    return CLAIMED;
  }
  process.chdir(record.workspace.path);
  const { code, signal } = await runDrive(
    driveCommand(record, driveScript()),
    record.workspace.path,
    passEnvironment(process.env, record),
  );
  // The wall first: once the exit is published the record no longer holds its
  // slot, and a tick in between would admit the walled account.
  const wallUnrecorded = code === QUOTA_PARKED && !(await tryWriteWall(record));
  recordExit(id, {
    at: new Date().toISOString(),
    code,
    signal,
    ...(wallUnrecorded ? { wallUnrecorded: true as const } : {}),
  });
  return code ?? 1;
}

/** The wrapper's command line; `jig dispatch run` reaches it too. */
export async function runMain(argv: string[]): Promise<number> {
  if (argv[0] === "identity" && argv.length === 2) {
    console.log(JSON.stringify(resolveAccountIdentity([argv[1] as string])));
    return 0;
  }
  if (argv.length !== 2) {
    console.error(
      "usage: run.ts <record> <token> | run.ts identity claude|codex",
    );
    return 2;
  }
  return wrap(argv[0] as string, argv[1] as string);
}

if (import.meta.main) process.exitCode = await runMain(process.argv.slice(2));
