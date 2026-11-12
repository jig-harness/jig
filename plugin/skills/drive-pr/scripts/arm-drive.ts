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
 *                [--pass-args "WORDS"] [--max-rounds N] [--keep-draft]
 *                [--handoff-at V]
 *
 *   --mode        overrides `do_item.arm_drive` (default `auto`) for this arm;
 *                 `print` where a human checkpoint withholds the drive
 *   --pass-model  the model each pass runs on, for this drive: a model id, a
 *                 Claude Code alias or a routing tier; default
 *                 `drive.pass_model`, else `sonnet`. The model it resolves to
 *                 is written into the pass command as `claude --model
 *                 <model>`; the flag itself is forwarded to `drive.ts`, so the
 *                 driver log names it as the source
 *   --pass-args   extra arguments for the pass command, for this drive: one
 *                 value, split on whitespace (`"--permission-mode
 *                 bypassPermissions"`); an empty value means none. Default
 *                 `drive.pass_args`, which only the host's user file or one
 *                 run's environment may set, else none. The words are written
 *                 into the pass command before `-p`, and the flag is
 *                 forwarded to `drive.ts`, as `--pass-model` is
 *   --max-rounds, --keep-draft, --handoff-at  forwarded to `drive.ts`
 *
 * The pass command is the session's own agent tool's (`lib/arm.ts`): in a
 * Codex session it is Codex's, on the standard tier of
 * `routing.models.codex` (by default `terra`, as `gpt-5.6-terra`), and
 * `--pass-model` overrides it, resolving tiers through the Codex row. It
 * carries `--dangerously-bypass-approvals-and-sandbox` only on a host that set
 * `drive.codex_bypass`, and Codex's own configuration decides otherwise.
 * `--pass-args` remains Claude Code's and is refused for Codex.
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
 * honoured, or a setting (`drive.pass_args` among them), the model or the
 * working tree could not be read, or the configuration names an AI reviewer
 * whose evidence the drive cannot read (`reviewerEvidenceProblem`); 2 usage: a malformed command line prints
 * its usage only, a `--pass-model` that names no model or a `--pass-args`
 * that holds a word it cannot (`--model`, `-p`) prints the `failed` report.
 */
import { resolve } from "node:path";
import { fail, isDigits, runMain, sleep } from "./lib/cli.ts";
import {
  arm,
  type ArmInputs,
  type ArmModel,
  type ArmReport,
  type ArmRequest,
  failedReport,
  type LiveDrive,
  liveDriveIn,
  sessionVendor,
  type TabDeps,
  tabTitle,
} from "./lib/arm.ts";
import { drives } from "./lib/driver/paths.ts";
import type { AccountVendor } from "./lib/identity.ts";
import {
  type ArmDriveMode,
  armDriveSetting,
  codexBypassSetting,
  DEFAULT_ARM_DRIVE,
  DEFAULT_PASS_MODEL,
  isArmDriveMode,
  ARM_DRIVE_MODES,
  reviewerEvidenceProblem,
} from "./lib/overlay.ts";
import {
  chosenPassArgs,
  type PassArgs,
  PassArgsUsageError,
  parsePassArgsFlag,
} from "./lib/pass-args.ts";
import {
  configuredCodexModel,
  configuredPassModel,
  PassModelUsageError,
  resolveModelValue,
} from "./lib/pass-model.ts";
import { git, gitIdentityEnv, run, tsArgv } from "./lib/proc.ts";
import { runOrca } from "../../../shared/orca.ts";
import {
  closePreviousTabs,
  defaultRunTabDeps,
  prSubject,
  recordRunTab,
} from "../../../shared/orca-tabs.ts";
import { currentMs } from "../../../shared/time.ts";

const USAGE =
  'usage: arm-drive.ts <PR> [--mode auto|tab|background|print] [--pass-model M] [--pass-args "WORDS"] [--max-rounds N] [--keep-draft] [--handoff-at V]';

interface Args {
  pr: string;
  mode: ArmDriveMode | undefined;
  passModel: string | undefined;
  passArgs: string | undefined;
  forward: string[];
}

/** The flags that take a value. */
const VALUE_FLAGS = new Set([
  "--mode",
  "--pass-model",
  "--pass-args",
  "--max-rounds",
  "--handoff-at",
]);

/** The flags whose value may start with `--`, since it is a pass command's own. */
const DASHED_VALUES = new Set(["--pass-args"]);

/** The flags of this command line, which a dashed value may not be mistaken for. */
const OWN_FLAGS = new Set([...VALUE_FLAGS, "--keep-draft"]);

function value(argv: string[], index: number): string {
  const v = argv[index + 1];
  const flag = argv[index] as string;
  const dashed = v?.startsWith("--") === true;
  if (
    v === undefined ||
    (dashed && !DASHED_VALUES.has(flag)) ||
    (dashed && (v === "--" || OWN_FLAGS.has(v.split(/\s/)[0] as string)))
  )
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
    case "--pass-args":
      args.passArgs = v;
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
    passArgs: undefined,
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

/** The flags a failed report's command leaves out, with their values. */
const PASS_FLAGS = new Set(["--pass-model", "--pass-args"]);

/** The model a failed report's command is built on when the configured one could not be read. */
function fallbackModel(vendor: AccountVendor): ArmModel {
  return vendor === "claude"
    ? {
        model: DEFAULT_PASS_MODEL,
        source: "the default, since the configured model could not be read",
      }
    : {
        model: null,
        source:
          "Codex's own configuration, since the configured model could not be read",
      };
}

/**
 * The arm's inputs, or the `failed` report of the first one that could not
 * be read (exit 2 for a `--pass-model` that names no model or a
 * `--pass-args` it refuses, else 1). The report's command is built on the
 * default model when the model could not be read, with no extra pass
 * arguments when they could not be read, and without the `--pass-model` and
 * `--pass-args` flags.
 */
async function readInputs(
  args: Args,
): Promise<ArmInputs | { report: ArmReport; exit: number }> {
  const tree = await workingTree();
  const vendor = sessionVendor(process.env) ?? "claude";
  const armDrive = attempt(() => setting(args.mode));
  const model = attempt(() => passModel(args.passModel, vendor));
  const passArgs = attempt(() => extraPassArgs(args.passArgs, vendor));
  const codexBypass = attempt(() => vendor === "codex" && codexBypassSetting());
  const evidence = readableReviewer();
  const problems = [tree, armDrive, model, passArgs, codexBypass, evidence];
  const problem = problems.find((v) => v instanceof Error);
  if (
    problem === undefined &&
    !(tree instanceof Error) &&
    !(armDrive instanceof Error) &&
    !(model instanceof Error) &&
    !(passArgs instanceof Error) &&
    !(codexBypass instanceof Error)
  )
    return {
      request: { pr: args.pr, tree, forward: args.forward },
      setting: armDrive,
      model,
      passArgs,
      codexBypass,
      env: process.env,
    };
  const noArgs: PassArgs = {
    words: [],
    source: "none, since the extra pass arguments could not be read",
  };
  const pr = args.pr;
  const forward = args.forward.filter(
    (word, i, all) =>
      !PASS_FLAGS.has(word) && !PASS_FLAGS.has(all[i - 1] ?? ""),
  );
  return {
    report: failedReport(
      { pr, tree: tree instanceof Error ? null : tree, forward },
      armDrive instanceof Error ? null : armDrive,
      {
        model: model instanceof Error ? fallbackModel(vendor) : model,
        passArgs: passArgs instanceof Error ? noArgs : passArgs,
        vendor,
        codexBypass: codexBypass === true,
      },
      `arm-drive.ts: ${problem?.message ?? "unknown"}`,
    ),
    exit:
      problem instanceof PassModelUsageError ||
      problem instanceof PassArgsUsageError
        ? 2
        : 1,
  };
}

/**
 * `true` when the drive can read the evidence of the AI reviewer the
 * repository names, else the error that refuses the arm: a drive armed on a
 * reviewer whose evidence it cannot read waits in `AWAITING_REVIEWER` until
 * its timeout.
 */
function readableReviewer(): true | Error {
  const problem = attempt(reviewerEvidenceProblem);
  if (problem === null) return true;
  return problem instanceof Error
    ? problem
    : new Error(`the drive cannot read the AI reviewer's evidence: ${problem}`);
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

/** The pass's model: Claude Code's `--pass-model`, else `drive.pass_model`; a Codex pass's from `routing.models.codex`. */
function passModel(flag: string | undefined, vendor: AccountVendor): ArmModel {
  if (vendor === "codex")
    return flag === undefined
      ? configuredCodexModel()
      : resolveModelValue(flag, "--pass-model", undefined, "codex");
  return flag === undefined
    ? configuredPassModel()
    : resolveModelValue(flag, "--pass-model");
}

/** The pass's extra arguments: Claude Code's; a Codex pass takes none, and `--pass-args` is refused for it. */
function extraPassArgs(
  flag: string | undefined,
  vendor: AccountVendor,
): PassArgs {
  if (vendor === "claude") return chosenPassArgs(flag);
  if (flag !== undefined && parsePassArgsFlag(flag).length > 0)
    throw new PassArgsUsageError(
      "--pass-args applies to a Claude Code pass command; a Codex pass takes its documented arguments",
    );
  return {
    words: [],
    source: "none; drive.pass_args applies to a Claude Code pass command",
  };
}

/** The live drive on the PR, read from `drives.ts --json` in the tree. */
async function liveDrive(
  request: ArmRequest,
  timeoutSec = 60,
): Promise<LiveDrive | null | "unreadable"> {
  const done = await run(tsArgv(drives, ["--json"]), {
    cwd: request.tree,
    stderr: "pipe",
    timeoutSec: Math.min(60, Math.max(1, timeoutSec)),
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
  const seconds = isDigits(raw) ? Number.parseInt(raw, 10) : 45;
  return Number.isSafeInteger(seconds) ? Math.min(seconds, 3600) : 45;
}

/** Print the report on stdout and its one-line summary on stderr; return the exit. */
function answer({ report, exit }: { report: ArmReport; exit: number }): number {
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `arm-drive.ts: ${report.status}${report.way === null ? "" : ` (${report.way})`} — ${report.fallback ?? report.reason}; pass model ${report.model ?? "none named"} (${report.modelSource}); permission mode ${report.permissionMode}`,
  );
  return exit;
}

/** Record the drive's tab as a run tab and close the PR's earlier ones, saying what happened on stderr. */
async function recordTab(
  result: Record<string, unknown>,
  orca: string,
  request: ArmRequest,
): Promise<void> {
  const tabs = defaultRunTabDeps();
  const subject = prSubject(request.pr);
  const recorded = await recordRunTab(
    {
      orca,
      result,
      worktree: request.tree,
      subject,
      title: tabTitle(request.pr),
    },
    tabs,
  );
  if ("unrecorded" in recorded) {
    console.error(
      `arm-drive.ts: the drive's tab stays open after the drive, since it is not recorded: ${recorded.unrecorded}`,
    );
    return;
  }
  const closed = await closePreviousTabs(
    { worktree: request.tree, subject, except: recorded.tab.handle },
    tabs,
  );
  for (const line of closed) console.error(`arm-drive.ts: ${line}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const inputs = await readInputs(args);
  if ("report" in inputs) return answer(inputs);
  const deps: TabDeps = {
    orca: runOrca,
    liveDrive,
    now: currentMs,
    sleep: (ms) => sleep(ms / 1000),
    confirmMs: confirmSeconds() * 1000,
    pollMs: 1500,
    runTab: recordTab,
  };
  return answer(await arm(inputs, deps));
}

if (import.meta.main) runMain("arm-drive.ts", main);
