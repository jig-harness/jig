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
 *                 `drive.pass_model`, else `sonnet`. The model it resolves to
 *                 is written into the pass command as `claude --model
 *                 <model>`; the flag itself is forwarded to `drive.ts`, so the
 *                 driver log names it as the source
 *   --max-rounds, --keep-draft, --handoff-at  forwarded to `drive.ts`
 *
 * Prints one JSON object (`ArmReport` in `lib/arm.ts`): `status` says what
 * the caller does next — `armed` (a tab runs the drive and `drives.ts` lists
 * it), `unconfirmed` (under `tab`: a tab opened, the drive was not listed in
 * time; `tail` is what the tab printed), `already-live` (a drive holds the
 * PR; no tab opened), `spawn` (start `command` with the session's background
 * execution; `fallback` says why when `auto` meant a tab), `print` (emit
 * `command` only, for the `reason` given), `failed` (`reason` says why, and
 * `command` is still built where the tree is known).
 * `DRIVE_PR_ARM_CONFIRM_SEC` (default 45) bounds the wait for a tab's drive.
 *
 * Exit codes: 0 decided (and, for a tab, opened); 1 `tab` could not be
 * honoured, or a setting, the model or the working tree could not be read;
 * 2 usage: a malformed command line prints its usage only, a `--pass-model`
 * that names no model prints the `failed` report.
 */
import { resolve } from "node:path";
import { fail, isDigits, runMain, sleep } from "./lib/cli.ts";
import {
  arm,
  type ArmInputs,
  type ArmReport,
  type ArmRequest,
  failedReport,
  type LiveDrive,
  liveDriveIn,
  type TabDeps,
} from "./lib/arm.ts";
import { drives } from "./lib/driver/paths.ts";
import {
  type ArmDriveMode,
  armDriveSetting,
  DEFAULT_ARM_DRIVE,
  DEFAULT_PASS_MODEL,
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
      args.forward.push(flag, v);
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

/** The working tree this runs in, where the drive runs; an error when there is none. */
async function workingTree(): Promise<string | Error> {
  const top = await git(["rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    timeoutSec: 30,
    env: gitIdentityEnv(),
  });
  const tree = top.stdout.trim();
  if (top.code === 0 && tree !== "") return resolve(tree);
  const said = top.stderr.trim();
  return new Error(
    `not in a git working tree; run it in the PR's tree${said === "" ? "" : ` (${said})`}`,
  );
}

/** `read()`, or the error it threw. */
function attempt<T>(read: () => T): T | Error {
  try {
    return read();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * The arm's inputs, or the `failed` report of the first one that could not
 * be read (exit 2 for a `--pass-model` that names no model, else 1). The
 * report's command is built on the default model when the model could not
 * be read, and without the `--pass-model` that failed.
 */
async function readInputs(
  args: Args,
): Promise<ArmInputs | { report: ArmReport; exit: number }> {
  const tree = await workingTree();
  const armDrive = attempt(() => setting(args.mode));
  const model = attempt(() => passModel(args.passModel));
  const problems = [tree, armDrive, model].filter((v) => v instanceof Error);
  const problem = problems[0];
  if (
    problem === undefined &&
    !(tree instanceof Error) &&
    !(armDrive instanceof Error) &&
    !(model instanceof Error)
  )
    return {
      request: { pr: args.pr, tree, forward: args.forward },
      setting: armDrive,
      model,
      env: process.env,
    };
  const fallback = {
    model: DEFAULT_PASS_MODEL,
    source: "the default, since the configured model could not be read",
  };
  const pr = args.pr;
  const forward = args.forward.filter(
    (word, i, all) => word !== "--pass-model" && all[i - 1] !== "--pass-model",
  );
  return {
    report: failedReport(
      { pr, tree: tree instanceof Error ? null : tree, forward },
      armDrive instanceof Error ? null : armDrive,
      model instanceof Error ? fallback : model,
      `arm-drive.ts: ${problem?.message ?? "unknown"}`,
    ),
    exit: problem instanceof PassModelUsageError ? 2 : 1,
  };
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

/** Print the report on stdout and its one-line summary on stderr; return the exit. */
function answer({ report, exit }: { report: ArmReport; exit: number }): number {
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `arm-drive.ts: ${report.status}${report.way === null ? "" : ` (${report.way})`} — ${report.fallback ?? report.reason}; pass model ${report.model} (${report.modelSource})`,
  );
  return exit;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const inputs = await readInputs(args);
  if ("report" in inputs) return answer(inputs);
  const deps: TabDeps = {
    orca: runOrca,
    liveDrive,
    now: Date.now,
    sleep: (ms) => sleep(ms / 1000),
    confirmMs: confirmSeconds() * 1000,
    pollMs: 1500,
  };
  return answer(await arm(inputs, deps));
}

if (import.meta.main) runMain("arm-drive.ts", main);
