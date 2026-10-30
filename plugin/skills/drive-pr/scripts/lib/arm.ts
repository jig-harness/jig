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
 * Whatever the setting, a session that is not Claude Code's prints the
 * command only: `claude` is the one documented pass command, and a guessed
 * one for another agent tool is worse than one left for a person to run.
 *
 * In a tab the drive outlives the session and has a window a person can
 * watch, and the session that implemented the item ends without a drive
 * running beside it. The tab only starts the drive: the command it types is
 * the one this module builds, quoted for a POSIX shell (Orca's tab shells
 * are the host's login shell, and Orca runs on POSIX hosts). Under `auto` a
 * tab Orca refuses falls back to the background, saying so; under `tab` the
 * refusal is the answer.
 */
import { shellQuote } from "../../../../shared/cli.ts";
import { detectHarness } from "../../../../shared/harness.ts";
import {
  type OrcaRunner,
  orcaFailure,
  orcaResult,
  orcaTabCommand,
} from "../../../../shared/orca.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { driveTs, drives } from "./driver/paths.ts";
import type { ArmDriveMode } from "./overlay.ts";
import type { PassModel } from "./pass-model.ts";

type Env = Record<string, string | undefined>;

/** The way a drive is armed once the setting meets the session. */
export type ArmWay = "tab" | "background" | "print";

/** What the caller asked for. */
export interface ArmRequest {
  pr: string;
  /** The working tree the drive runs in. */
  tree: string;
  /** Drive flags for `drive.ts`, before its `--`: `--max-rounds N` and the like. */
  forward: string[];
}

/**
 * A word of a command line, quoted so that a POSIX shell, PowerShell and
 * `cmd.exe` all read it back unchanged where they can: bare when it holds
 * only characters no shell treats specially, in double quotes when it holds
 * none of the characters a shell expands there, and in POSIX single quotes
 * otherwise (which `cmd.exe` cannot read; the drive's shells are POSIX).
 */
export function quoteWord(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_\-./:=+@,]+$/.test(word)) return word;
  if (!/["$`\\!%\r\n]/.test(word)) return `"${word}"`;
  return shellQuote(word);
}

/** `argv` as one command line (`quoteWord` for each word). */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteWord).join(" ");
}

/** The argument list that starts the drive: `drive.ts` in the tree, its pass on `model`. */
export function driveArgv(request: ArmRequest, model: string): string[] {
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
    "claude",
    "--model",
    model,
    "-p",
    `/jig:drive-pr --bots-only ${pr}`,
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

/** The way chosen, and why; a tab carries Orca's command. */
export type WayChoice =
  | { way: "tab"; orca: string; reason: string }
  | { way: "background" | "print"; reason: string };

/** The way to arm, and why; `error` when the setting asks for what this session cannot do. */
export function chooseWay(
  setting: ArmDriveMode,
  env: Env,
): WayChoice | { error: string } {
  if (setting === "print")
    return { way: "print", reason: "arm_drive is print: the command only" };
  const harness = detectHarness(env)?.name ?? null;
  if (harness !== "claude-code")
    return {
      way: "print",
      reason: `the pass command is Claude Code's, and this session runs ${harness ?? "no agent harness this can identify"}: the command only, for a person to run`,
    };
  const orca = orcaTabCommand(env);
  if (setting === "background")
    return { way: "background", reason: "arm_drive is background" };
  if (setting === "tab")
    return orca !== null
      ? { way: "tab", orca, reason: "arm_drive is tab" }
      : {
          error:
            "arm_drive is tab, but this session cannot open a terminal tab: it does not run in an Orca terminal",
        };
  return orca !== null
    ? { way: "tab", orca, reason: "arm_drive is auto, and Orca can open a tab" }
    : {
        way: "background",
        reason:
          "arm_drive is auto, and this session cannot open a terminal tab",
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
  doctor: unknown;
}

/** What the tab flow needs from outside; tests replace each. */
export interface TabDeps {
  orca: OrcaRunner;
  /** The live drive on the PR, `null` for none, `"unreadable"` when the listing failed. */
  liveDrive: (request: ArmRequest) => Promise<LiveDrive | null | "unreadable">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the drive to be listed once the tab is open. */
  confirmMs: number;
  pollMs: number;
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
  const terminal = isRecord(result.terminal) ? result.terminal : result;
  return typeof terminal.handle === "string" && terminal.handle !== ""
    ? terminal.handle
    : null;
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
  if (before !== null && before !== "unreadable")
    return { status: "already-live", drive: before };
  const opened = deps.now();
  const done = await deps.orca(orca, tabArgs(request, command));
  const result = orcaResult(done);
  if (result === null)
    return {
      status: "failed",
      why: `orca terminal create failed ${orcaFailure(done)}`,
    };
  const terminal = terminalHandle(result);
  const deadline = opened + deps.confirmMs;
  for (;;) {
    const drive = await deps.liveDrive(request);
    if (
      drive !== null &&
      drive !== "unreadable" &&
      Date.parse(drive.started ?? "") >= opened - STARTED_SLACK_MS
    )
      return { status: "armed", terminal, drive };
    if (deps.now() >= deadline) break;
    await deps.sleep(deps.pollMs);
  }
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
      doctor: row.doctor ?? null,
    };
  }
  return null;
}

/** The whole answer `arm-drive.ts` prints. */
export interface ArmReport {
  pr: string;
  tree: string;
  armDrive: { value: ArmDriveMode; source: string };
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
  /** Set when a tab could not open under `auto` and the drive goes to the background. */
  fallback: string | null;
  model: string;
  modelSource: string;
  command: string;
  argv: string[];
  tab: { title: string; terminal: string | null } | null;
  /** The tab's last lines, when the drive did not show up. */
  tail: string[];
  drive: LiveDrive | null;
  handles: { list: string; stop: string };
}

/** Everything the arm decides from, read before it acts. */
export interface ArmInputs {
  request: ArmRequest;
  setting: { value: ArmDriveMode; source: string };
  model: PassModel;
  env: Env;
}

/** Decide, open a tab where that is the way, and report; exit 1 when the setting cannot be honoured. */
export async function arm(
  inputs: ArmInputs,
  deps: TabDeps,
): Promise<{ report: ArmReport; exit: number }> {
  const { request, setting, model, env } = inputs;
  const argv = driveArgv(request, model.model);
  const command = commandLine(argv);
  const base: ArmReport = {
    pr: request.pr,
    tree: request.tree,
    armDrive: setting,
    way: null,
    status: "failed",
    reason: "",
    fallback: null,
    model: model.model,
    modelSource: model.source,
    command,
    argv,
    tab: null,
    tail: [],
    drive: null,
    handles: driveHandles(request),
  };
  const choice = chooseWay(setting.value, env);
  if ("error" in choice)
    return { report: { ...base, reason: choice.error }, exit: 1 };
  const chosen = { ...base, way: choice.way, reason: choice.reason };
  if (choice.way !== "tab")
    return {
      report: {
        ...chosen,
        status: choice.way === "print" ? "print" : "spawn",
      },
      exit: 0,
    };
  const outcome = await armInTab(choice.orca, request, command, deps);
  const tab = { title: tabTitle(request.pr), terminal: null };
  switch (outcome.status) {
    case "already-live":
      return {
        report: { ...chosen, status: outcome.status, drive: outcome.drive },
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
    case "unconfirmed":
      return {
        report: {
          ...chosen,
          status: "unconfirmed",
          tab: { ...tab, terminal: outcome.terminal },
          tail: outcome.tail,
        },
        exit: 0,
      };
    case "failed":
      if (setting.value === "auto")
        return {
          report: {
            ...chosen,
            way: "background",
            status: "spawn",
            fallback: `${outcome.why}; arming in the background instead`,
          },
          exit: 0,
        };
      return {
        report: { ...chosen, status: "failed", reason: outcome.why },
        exit: 1,
      };
  }
}
