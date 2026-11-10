/**
 * Arming a drive: which way it starts, the command that starts it, and, in
 * a terminal tab, whether it started. `arm-drive.ts` is the command line;
 * `/jig:do-item`'s § Arm the drive and `/jig:drive-pr`'s § Arm both call it,
 * so the two entry points arm alike.
 *
 * The way, `do_item.arm_drive` (or `--mode`):
 *
 *   auto        a terminal tab of the PR's workspace where the session can
 *               open one (Orca), else the session's background execution
 *   tab         a terminal tab, or a failure that says why not
 *   background  the session's background execution, as before tabs
 *   print       the command only, for a person to run
 *
 * The pass command is the session's own agent tool's documented one
 * (`pass-command.ts`): Claude Code's in a Claude Code session, Codex's in a
 * Codex session, with the bypass only on a host that set
 * `drive.codex_bypass`. Both use a tab where available, otherwise the
 * session's managed background execution. A session of any other tool,
 * or one no harness can be read for, prints Claude Code's command only: a guessed one for another agent
 * tool is worse than one left for a person to run.
 *
 * In a tab the drive outlives the session and has a window a person can
 * watch, and the session that implemented the item ends without a drive
 * running beside it. The tab is a fresh login shell of the user's: `bun`,
 * the agent's CLI and its account come from it, not from the session. The
 * tab only starts the drive: the command it types is the one this module
 * builds, quoted for a POSIX shell. On a Windows host Orca's tab can be
 * `cmd.exe` or PowerShell, which that quoting is not written for, so a
 * Windows host opens no tab. Under `auto` a tab that cannot be opened, or
 * whose drive `drives.ts` does not list in time, falls back to the
 * background, saying why (a drive the tab did start refuses the second on
 * its lock); under `tab` that is the answer. The tab is recorded as a run
 * tab (`shared/orca-tabs.ts`): the drive closes it when it ends with nothing
 * for a person, and arming the PR again closes its earlier idle run tabs.
 */
import { shellQuote } from "../../../../shared/cli.ts";
import { sessionOverrides } from "../../../../shared/session-overrides.ts";

import { detectHarness } from "../../../../shared/harness.ts";
import {
  type OrcaRunner,
  orcaFailure,
  orcaResult,
  orcaTabCommand,
} from "../../../../shared/orca.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { driveTs, drives } from "./driver/paths.ts";
import type { AccountVendor } from "./identity.ts";
import type { ArmDriveMode } from "./overlay.ts";
import { codexPermission, type PassArgs, permissionMode } from "./pass-args.ts";
import { runTabEnv } from "../../../../shared/orca-tabs.ts";
import { passCommand } from "./pass-command.ts";
import { withCodexModel } from "./pass-model.ts";

type Env = Record<string, string | undefined>;

/** The model a drive's passes run on and where it came from; `null` when the pass command's tool decides. */
export interface ArmModel {
  model: string | null;
  source: string;
}

/**
 * The agent tool whose pass command a session arms: Claude Code's in a
 * Claude Code session, Codex's in a Codex session; `null` for any other.
 */
export function sessionVendor(env: Env): AccountVendor | null {
  const harness = detectHarness(env)?.name ?? null;
  if (harness === "claude-code") return "claude";
  if (harness === "codex") return "codex";
  return null;
}

/** The way a drive is armed once the setting meets the session. */
export type ArmWay = "tab" | "background" | "print";

/** What the caller asked for. */
export interface ArmRequest {
  pr: string;
  /** The working tree the drive runs in. */
  tree: string;
  /**
   * Drive flags for `drive.ts`, before its `--`: `--max-rounds N` and the
   * like, and `--pass-model` or `--pass-args` when the caller names the
   * model or the extra pass arguments, so the driver log says they came from
   * there.
   */
  forward: string[];
}

/**
 * A word of a command line, quoted so that a POSIX shell, PowerShell and
 * `cmd.exe` all read it back unchanged where they can: bare when it holds
 * only characters no shell treats specially, in double quotes when it holds
 * none of the characters a shell expands there, and otherwise in the single
 * quotes of the shell that reads it on `platform`: PowerShell's on Windows
 * (a doubled `'` inside), POSIX's elsewhere. `cmd.exe` reads neither.
 */
export function quoteWord(
  word: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (word !== "" && /^[A-Za-z0-9_\-./:=+@,]+$/.test(word)) return word;
  if (!/["$`\\!%\r\n]/.test(word)) return `"${word}"`;
  if (platform === "win32") return `'${word.replaceAll("'", "''")}'`;
  return shellQuote(word);
}

/** `argv` as one command line (`quoteWord` for each word, for `platform`'s shell). */
export function commandLine(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return argv.map((word) => quoteWord(word, platform)).join(" ");
}

/**
 * The pass command `vendor` runs on `model`: Claude Code's with `passArgs`
 * before its `-p`; Codex's with `-m` after `exec` (none when `model` is
 * `null`, so Codex's own configuration decides) and the bypass when
 * `codexBypass` says the host opted in.
 */
function passArgv(
  vendor: AccountVendor,
  pr: string,
  model: string | null,
  passArgs: readonly string[],
  codexBypass: boolean,
): string[] {
  const pass = passCommand(vendor, pr, codexBypass);
  if (vendor === "codex")
    return model === null ? pass : withCodexModel(pass, model);
  const [claude, ...prompt] = pass;
  return [
    claude as string,
    ...(model === null ? [] : ["--model", model]),
    ...passArgs,
    ...prompt,
  ];
}

/**
 * The argument list that starts the drive: `drive.ts` in the tree, its pass
 * (`vendor`'s documented pass command) on `model`, with `passArgs` before a
 * Claude Code pass's `-p` and, on a host that opted in, a Codex pass's bypass.
 */
export function driveArgv(
  request: ArmRequest,
  model: string | null,
  passArgs: readonly string[] = [],
  vendor: AccountVendor = "claude",
  codexBypass = false,
): string[] {
  const { pr, tree, forward } = request;
  return [
    "bun",
    "--cwd",
    tree,
    driveTs,
    pr,
    "--bots-only",
    ...forward,
    "--",
    ...passArgv(vendor, pr, model, passArgs, codexBypass),
  ];
}

/** The commands a person uses on the drive: list the clone's drives, stop this one. */
export function driveHandles(request: ArmRequest): {
  list: string;
  stop: string;
} {
  const list = ["bun", "--cwd", request.tree, drives];
  return {
    list: commandLine(list),
    stop: commandLine([...list, "--stop", request.pr]),
  };
}

/** The way chosen, and why; a tab carries Orca's command, a fallback says what was not done. */
export type WayChoice =
  | { way: "tab"; orca: string; reason: string }
  | { way: "background" | "print"; reason: string; fallback?: string };

/** Why a Windows host opens no tab. */
const WINDOWS_TAB =
  "on a Windows host Orca's tab can run cmd.exe or PowerShell, and the drive's command is quoted for a POSIX shell";

/** The tab, or on a Windows host the background (under `auto`) or a refusal (under `tab`). */
function tabOn(
  setting: "auto" | "tab",
  orca: string,
  platform: NodeJS.Platform,
): WayChoice | { error: string } {
  if (platform !== "win32")
    return { way: "tab", orca, reason: `arm_drive is ${setting}` };
  if (setting === "tab")
    return { error: `arm_drive is tab, but ${WINDOWS_TAB}` };
  return {
    way: "background",
    reason: "arm_drive is auto",
    fallback: `${WINDOWS_TAB}; arming in the background instead`,
  };
}

/** The way to arm, and why; `error` when the setting asks for what this session cannot do. */
export function chooseWay(
  setting: ArmDriveMode,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): WayChoice | { error: string } {
  if (setting === "print")
    return { way: "print", reason: "arm_drive is print: the command only" };
  const vendor = sessionVendor(env);
  if (vendor === null)
    return {
      way: "print",
      reason: `the documented pass commands are Claude Code's and Codex's, and this session runs ${detectHarness(env)?.name ?? "no agent harness this can identify"}: Claude Code's command only, for a person to run`,
    };
  return tabOrBackground(setting, env, platform);
}

/** The way to arm from a session that can open a tab or run in the background. */
function tabOrBackground(
  setting: Exclude<ArmDriveMode, "print">,
  env: Env,
  platform: NodeJS.Platform,
): WayChoice | { error: string } {
  const orca = orcaTabCommand(env);
  if (setting === "background")
    return { way: "background", reason: "arm_drive is background" };
  if (orca !== null) return tabOn(setting, orca, platform);
  if (setting === "tab")
    return {
      error:
        "arm_drive is tab, but this session cannot open a terminal tab: it does not run in an Orca terminal",
    };
  return {
    way: "background",
    reason: "arm_drive is auto, and this session cannot open a terminal tab",
  };
}

/** The arguments of Orca's call that opens the drive's tab in the tree's workspace. */
export function tabArgs(request: ArmRequest, command: string): string[] {
  return [
    "terminal",
    "create",
    "--worktree",
    `path:${request.tree}`,
    "--title",
    tabTitle(request.pr),
    "--command",
    command,
    "--json",
  ];
}

export function tabTitle(pr: string): string {
  return `drive #${pr}`;
}

/** A live drive on the PR, as `drives.ts --json` lists it. */
export interface LiveDrive {
  pid: number | null;
  started: string | null;
  log: string | null;
  model: string | null;
  permissionMode: string | null;
  doctor: unknown;
}

/** What the tab flow needs from outside; tests replace each. */
export interface TabDeps {
  orca: OrcaRunner;
  /** The live drive on the PR, `null` for none, `"unreadable"` when the listing failed. */
  liveDrive: (
    request: ArmRequest,
    timeoutSec?: number,
  ) => Promise<LiveDrive | null | "unreadable">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the drive to be listed once the tab is open. */
  confirmMs: number;
  pollMs: number;
  /**
   * Record the tab `terminal create` answered `result` for, so the drive
   * closes it when it ends, and close the PR's earlier run tabs; it never
   * fails the arm. Without it the tab is not recorded and stays open.
   */
  runTab?: (
    result: Record<string, unknown>,
    orca: string,
    request: ArmRequest,
  ) => Promise<void>;
}

/** How the tab flow ended. */
export type TabOutcome =
  | { status: "already-live"; drive: LiveDrive }
  | { status: "failed"; why: string }
  | { status: "armed"; terminal: string | null; drive: LiveDrive }
  | { status: "unconfirmed"; terminal: string | null; tail: string[] };

/** A clock skew allowance between the tab's start and the drive's claim. */
const STARTED_SLACK_MS = 5_000;

/** The terminal handle in a `terminal create` result. */
function terminalHandle(result: Record<string, unknown>): string | null {
  const nested = isRecord(result.terminal) ? result.terminal.handle : undefined;
  for (const handle of [nested, result.handle])
    if (typeof handle === "string" && handle !== "") return handle;
  return null;
}

/** The last lines the tab printed, best effort. */
async function tabTail(
  orca: string,
  handle: string,
  deps: TabDeps,
): Promise<string[]> {
  const done = await deps.orca(orca, [
    "terminal",
    "read",
    "--terminal",
    handle,
    "--limit",
    "40",
    "--json",
  ]);
  const terminal = orcaResult(done)?.terminal;
  const tail = isRecord(terminal) ? terminal.tail : undefined;
  return Array.isArray(tail)
    ? tail.filter((line): line is string => typeof line === "string")
    : [];
}

/** Record the opened tab through `deps.runTab`; a failure is reported and never stops the arm. */
async function recordTabSafely(
  deps: TabDeps,
  result: Record<string, unknown>,
  orca: string,
  request: ArmRequest,
): Promise<void> {
  try {
    await deps.runTab?.(result, orca, request);
  } catch (error) {
    console.error(
      `arm: the drive's tab is not recorded and stays open (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Poll until the clone lists a drive on the PR that started after the tab opened, or `confirmMs` passes. */
async function awaitDrive(
  request: ArmRequest,
  opened: number,
  deps: TabDeps,
): Promise<LiveDrive | null> {
  const deadline = opened + deps.confirmMs;
  for (;;) {
    const left = deadline - deps.now();
    if (left <= 0) return null;
    const drive = await deps.liveDrive(request, Math.ceil(left / 1000));
    if (
      drive !== null &&
      drive !== "unreadable" &&
      Date.parse(drive.started ?? "") >= opened - STARTED_SLACK_MS
    )
      return drive;
    if (deadline - deps.now() <= 0) return null;
    await deps.sleep(deps.pollMs);
  }
}

/**
 * Open the drive's tab and wait, polling up to `confirmMs`, until the
 * clone's drives list a drive on the PR that started after the tab opened.
 * A drive already live on the PR opens no tab: the new one would only meet
 * its lock.
 */
export async function armInTab(
  orca: string,
  request: ArmRequest,
  command: string,
  deps: TabDeps,
): Promise<TabOutcome> {
  const before = await deps.liveDrive(request);
  if (before === "unreadable")
    return {
      status: "failed",
      why: "drives.ts could not be read, so a drive already live on the PR cannot be ruled out; no tab opened",
    };
  if (before !== null) return { status: "already-live", drive: before };
  const opened = deps.now();
  const done = await deps.orca(orca, tabArgs(request, command));
  const result = orcaResult(done);
  if (result === null)
    return {
      status: "failed",
      why: `orca terminal create failed ${orcaFailure(done)}`,
    };
  const terminal = terminalHandle(result);
  await recordTabSafely(deps, result, orca, request);
  const drive = await awaitDrive(request, opened, deps);
  if (drive !== null) return { status: "armed", terminal, drive };
  const tail = terminal === null ? [] : await tabTail(orca, terminal, deps);
  return { status: "unconfirmed", terminal, tail };
}

/** The live PR row for `pr` in `drives.ts --json`'s output; `null` for none. */
export function liveDriveIn(json: unknown, pr: string): LiveDrive | null {
  const rows = isRecord(json) && Array.isArray(json.rows) ? json.rows : [];
  for (const row of rows) {
    if (!isRecord(row) || row.kind !== "pr" || row.key !== pr) continue;
    if (row.state !== "live") continue;
    const diag = isRecord(row.diag) ? row.diag : {};
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      pid: typeof row.pid === "number" ? row.pid : null,
      started: text(diag.started),
      log: text(diag.log),
      model: text(diag.model),
      permissionMode: text(diag.permissionMode),
      doctor: row.doctor ?? null,
    };
  }
  return null;
}

/** The whole answer `arm-drive.ts` prints. */
export interface ArmReport {
  pr: string;
  /** `null` when the arm failed before it knew the tree. */
  tree: string | null;
  /** `null` when the setting could not be read. */
  armDrive: { value: ArmDriveMode; source: string } | null;
  way: ArmWay | null;
  /**
   * What the caller does next: `armed`, `unconfirmed` and `already-live`
   * after a tab; `spawn` (start `command` in the background); `print` (emit
   * it only); `failed`.
   */
  status:
    | "armed"
    | "unconfirmed"
    | "already-live"
    | "spawn"
    | "print"
    | "failed";
  reason: string;
  /** Set when `auto` meant a tab and the drive goes to the background instead: why. */
  fallback: string | null;
  /** `null` when the pass command's tool decides (a Codex pass with no model configured). */
  model: string | null;
  modelSource: string;
  /** The extra words the pass command carries before `-p`, and their source. */
  passArgs: string[];
  passArgsSource: string;
  /** The permission mode the pass runs in (`pass-args.ts`). */
  permissionMode: string;
  /** `null`, with `argv` empty, when the arm failed before it knew the tree. */
  command: string | null;
  argv: string[];
  tab: { title: string; terminal: string | null } | null;
  /** The tab's last lines, when the drive did not show up. */
  tail: string[];
  drive: LiveDrive | null;
  handles: { list: string; stop: string } | null;
}

/**
 * The report of an arm that failed before it decided: a setting, the model,
 * the extra pass arguments or the working tree could not be read. `command`
 * is built on `model` (the default where the configured one could not be
 * read) and `passArgs` (none where they could not be read) once the tree is
 * known, for `vendor`'s pass command (Claude Code's when none is named), with
 * a Codex pass's bypass only when `codexBypass` says the host opted in.
 */
export function failedReport(
  request: { pr: string; tree: string | null; forward: string[] },
  setting: ArmReport["armDrive"],
  pass: {
    model: ArmModel;
    passArgs: PassArgs;
    vendor?: AccountVendor;
    codexBypass?: boolean;
  },
  reason: string,
): ArmReport {
  const { model, passArgs } = pass;
  const vendor = pass.vendor ?? "claude";
  const codexBypass = pass.codexBypass === true;
  const tree = request.tree;
  const known = tree === null ? null : { ...request, tree };
  const argv =
    known === null
      ? []
      : driveArgv(known, model.model, passArgs.words, vendor, codexBypass);
  const permission =
    vendor === "codex"
      ? codexPermission(passArgv(vendor, request.pr, null, [], codexBypass))
      : permissionMode(["claude", ...passArgs.words]);
  return {
    pr: request.pr,
    tree,
    armDrive: setting,
    way: null,
    status: "failed",
    reason,
    fallback: null,
    model: model.model,
    modelSource: model.source,
    passArgs: passArgs.words,
    passArgsSource: passArgs.source,
    permissionMode: permission.mode ?? "default",
    command: known === null ? null : commandLine(argv),
    argv,
    tab: null,
    tail: [],
    drive: null,
    handles: known === null ? null : driveHandles(known),
  };
}

/** Everything the arm decides from, read before it acts. */
export interface ArmInputs {
  request: ArmRequest;
  setting: { value: ArmDriveMode; source: string };
  /** The model of the session's agent tool's pass (`sessionVendor(env)`; Claude Code's for any other session). */
  model: ArmModel;
  passArgs: PassArgs;
  /** Whether a Codex pass carries the bypass: the host's `drive.codex_bypass`. */
  codexBypass?: boolean;
  env: Env;
  platform?: NodeJS.Platform;
}

/** Decide, open a tab where that is the way, and report; exit 1 when the setting cannot be honoured. */
export async function arm(
  inputs: ArmInputs,
  deps: TabDeps,
): Promise<{ report: ArmReport; exit: number }> {
  const { request, setting, model, passArgs, env, codexBypass } = inputs;
  const vendor = sessionVendor(env) ?? "claude";
  const base = failedReport(
    request,
    setting,
    { model, passArgs, vendor, codexBypass: codexBypass === true },
    "",
  );
  const choice = chooseWay(setting.value, env, inputs.platform);
  if ("error" in choice)
    return { report: { ...base, reason: choice.error }, exit: 1 };
  const chosen = { ...base, way: choice.way, reason: choice.reason };
  if (choice.way !== "tab")
    return {
      report: {
        ...chosen,
        status: choice.way === "print" ? "print" : "spawn",
        fallback: choice.fallback ?? null,
      },
      exit: 0,
    };
  const outcome = await armInTab(
    choice.orca,
    request,
    commandLine([...sessionOverrides(env), ...runTabEnv(env), ...base.argv]),
    deps,
  );
  return tabReport(chosen, outcome, setting.value === "auto");
}

/**
 * `report` sent to the session's background execution instead of a tab, saying why.
 */
function fallBack(
  report: ArmReport,
  why: string,
): { report: ArmReport; exit: number } {
  return {
    report: {
      ...report,
      way: "background",
      status: "spawn",
      fallback: `${why}; arming in the background instead`,
    },
    exit: 0,
  };
}

/**
 * The report after a tab. Under `auto`, a tab that did not open, or whose
 * drive was not listed in time, falls back to the background: a drive the
 * tab did start holds the PR's lock, so the second refuses (exit `11`).
 */
function tabReport(
  chosen: ArmReport,
  outcome: TabOutcome,
  auto: boolean,
): { report: ArmReport; exit: number } {
  const tab = { title: tabTitle(chosen.pr), terminal: null };
  switch (outcome.status) {
    case "already-live":
      return {
        report: {
          ...chosen,
          status: outcome.status,
          drive: outcome.drive,
          model: outcome.drive.model ?? "unknown",
          modelSource:
            outcome.drive.model === null
              ? "the live drive records no model"
              : "the live drive's own record, not this request",
          permissionMode: outcome.drive.permissionMode ?? "unknown",
        },
        exit: 0,
      };
    case "armed":
      return {
        report: {
          ...chosen,
          status: "armed",
          tab: { ...tab, terminal: outcome.terminal },
          drive: outcome.drive,
        },
        exit: 0,
      };
    case "unconfirmed": {
      const seen = {
        ...chosen,
        tab: { ...tab, terminal: outcome.terminal },
        tail: outcome.tail,
      };
      if (auto)
        return fallBack(
          seen,
          "the tab opened, but drives.ts did not list its drive in time (tail has what the tab printed)",
        );
      return { report: { ...seen, status: "unconfirmed" }, exit: 0 };
    }
    case "failed":
      if (auto) return fallBack(chosen, outcome.why);
      return {
        report: { ...chosen, status: "failed", reason: outcome.why },
        exit: 1,
      };
  }
}
