#!/usr/bin/env bun
/**
 * Arm the drive of one pull request from a session: decide how it starts,
 * build the command that starts it, and start it in a terminal tab of the
 * PR's workspace where that is the way (`lib/arm.ts` says how each is
 * chosen). The drive runs in the working tree this is run in: run it there
 * (`bun --cwd <tree> …`).
 *
 * Usage:
 *   arm-drive.ts <PR> [--mode auto|tab|background|print] [--pass-model M]
 *                [--max-rounds N] [--keep-draft] [--handoff-at V]
 *
 *   --mode        overrides `do_item.arm_drive` (default `auto`) for this arm;
 *                 `print` where a human checkpoint withholds the drive
 *   --pass-model  the model each pass runs on, for this drive: a model id, a
 *                 Claude Code alias or a routing tier; default
 *                 `drive.pass_model`, else `sonnet`. Written into the pass
 *                 command as `claude --model <model>`
 *   --max-rounds, --keep-draft, --handoff-at  forwarded to `drive.ts`
 *
 * Prints one JSON object (`ArmReport` in `lib/arm.ts`): `status` says what
 * the caller does next — `armed` (a tab runs the drive and `drives.ts` lists
 * it), `unconfirmed` (a tab opened, the drive was not listed in time; `tail`
 * is what the tab printed), `already-live` (a drive holds the PR; no tab
 * opened), `spawn` (start `command` with the session's background
 * execution), `print` (emit `command` only, for the `reason` given).
 * `DRIVE_PR_ARM_CONFIRM_SEC` (default 45) bounds the wait for a tab's drive.
 *
 * Exit codes: 0 decided (and, for a tab, opened); 1 `tab` could not be
 * honoured, or a setting or the working tree could not be read; 2 usage.
 */
import { resolve } from "node:path";
import { fail, isDigits, runMain, sleep } from "./lib/cli.ts";
import {
  arm,
  type ArmRequest,
  type LiveDrive,
  liveDriveIn,
  type TabDeps,
} from "./lib/arm.ts";
import { drives } from "./lib/driver/paths.ts";
import {
  type ArmDriveMode,
  armDriveSetting,
  DEFAULT_ARM_DRIVE,
  isArmDriveMode,
  ARM_DRIVE_MODES,
} from "./lib/overlay.ts";
import {
  configuredPassModel,
  type PassModel,
  PassModelUsageError,
  resolveModelValue,
} from "./lib/pass-model.ts";
import { git, gitIdentityEnv, run, tsArgv } from "./lib/proc.ts";
import { runOrca } from "../../../shared/orca.ts";

const USAGE =
  "usage: arm-drive.ts <PR> [--mode auto|tab|background|print] [--pass-model M] [--max-rounds N] [--keep-draft] [--handoff-at V]";

interface Args {
  pr: string;
  mode: ArmDriveMode | undefined;
  passModel: string | undefined;
  forward: string[];
}

/** The flags that take a value. */
const VALUE_FLAGS = new Set([
  "--mode",
  "--pass-model",
  "--max-rounds",
  "--handoff-at",
]);

function value(argv: string[], index: number): string {
  const v = argv[index + 1];
  if (v === undefined || v.startsWith("--"))
    fail(2, `${argv[index]} requires a value`, USAGE);
  return v;
}

/** Record one flag's value, refusing one the flag does not take. */
function takeValue(args: Args, flag: string, v: string): void {
  switch (flag) {
    case "--mode":
      if (!isArmDriveMode(v))
        fail(2, `--mode takes one of ${ARM_DRIVE_MODES.join(", ")}`, USAGE);
      args.mode = v;
      return;
    case "--pass-model":
      args.passModel = v;
      return;
    case "--max-rounds":
      if (!isDigits(v) || Number.parseInt(v, 10) < 1)
        fail(2, "--max-rounds takes a whole number of at least 1", USAGE);
      args.forward.push(flag, v);
      return;
    default:
      args.forward.push(flag, v);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pr: "",
    mode: undefined,
    passModel: undefined,
    forward: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (VALUE_FLAGS.has(flag)) takeValue(args, flag, value(argv, i++));
    else if (flag === "--keep-draft") args.forward.push(flag);
    else if (flag.startsWith("-") || args.pr !== "") fail(2, USAGE);
    else args.pr = flag;
  }
  if (!isDigits(args.pr) || BigInt(args.pr).toString() !== args.pr)
    fail(2, "arm-drive.ts: the PR is a number without leading zeros", USAGE);
  return args;
}

/** The working tree this runs in; the drive runs there. */
async function workingTree(): Promise<string> {
  const top = await git(["rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    timeoutSec: 30,
    env: gitIdentityEnv(),
  });
  const tree = top.stdout.trim();
  if (top.code !== 0 || tree === "")
    fail(
      1,
      "arm-drive.ts: not in a git working tree; run it in the PR's tree",
      top.stderr.trim(),
    );
  return resolve(tree);
}

function setting(mode: ArmDriveMode | undefined): {
  value: ArmDriveMode;
  source: string;
} {
  if (mode !== undefined) return { value: mode, source: "--mode" };
  const configured = armDriveSetting();
  return configured === undefined
    ? { value: DEFAULT_ARM_DRIVE, source: "the default" }
    : { value: configured, source: "do_item.arm_drive" };
}

function passModel(flag: string | undefined): PassModel {
  return flag === undefined
    ? configuredPassModel()
    : resolveModelValue(flag, "--pass-model");
}

/** The live drive on the PR, read from `drives.ts --json` in the tree. */
async function liveDrive(
  request: ArmRequest,
): Promise<LiveDrive | null | "unreadable"> {
  const done = await run(tsArgv(drives, ["--json"]), {
    cwd: request.tree,
    stderr: "pipe",
    timeoutSec: 60,
  });
  if (done.code !== 0) return "unreadable";
  try {
    return liveDriveIn(JSON.parse(done.stdout), request.pr);
  } catch {
    return "unreadable";
  }
}

function confirmSeconds(): number {
  const raw = process.env.DRIVE_PR_ARM_CONFIRM_SEC ?? "";
  return isDigits(raw) ? Number.parseInt(raw, 10) : 45;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const tree = await workingTree();
  let inputs: Parameters<typeof arm>[0];
  try {
    inputs = {
      request: { pr: args.pr, tree, forward: args.forward },
      setting: setting(args.mode),
      model: passModel(args.passModel),
      env: process.env,
    };
  } catch (e) {
    return fail(
      e instanceof PassModelUsageError ? 2 : 1,
      `arm-drive.ts: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const deps: TabDeps = {
    orca: runOrca,
    liveDrive,
    now: Date.now,
    sleep: (ms) => sleep(ms / 1000),
    confirmMs: confirmSeconds() * 1000,
    pollMs: 1500,
  };
  const { report, exit } = await arm(inputs, deps);
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `arm-drive.ts: ${report.status}${report.way === null ? "" : ` (${report.way})`} — ${report.fallback ?? report.reason}; pass model ${report.model} (${report.modelSource})`,
  );
  return exit;
}

if (import.meta.main) runMain("arm-drive.ts", main);
