/**
 * Run tabs: the Orca terminal tabs Jig opens for a run (a drive armed in a
 * tab, a stage the dispatcher launches), closed again once the run ends with
 * nothing left for a person to look at.
 *
 * The opener records each tab it opens: its handle, the PID and start time
 * of the login shell Orca started in it, the worktree and what the run is
 * for (a pull request, an item). When a new run opens for the same subject
 * in the same worktree, the opener closes that subject's earlier run tabs.
 * When the tab's own command (the process whose parent is the recorded
 * shell) ends, it calls `endOwnTab`, which starts a detached closer: the
 * closer waits for the command to exit, then closes the tab through Orca
 * while its shell is still alive, since a tab whose shell exited stays as a
 * pane Orca no longer closes by its handle.
 *
 * Only the recorded terminal is closed, never its whole tab, so a pane a
 * person added beside it stays. It is closed only while it is idle: its shell
 * is still the one recorded and has no child process, so a terminal someone
 * typed a command into stays, and the closer gives up as soon as it sees a
 * process that was not there when the run was ending. A
 * process table that cannot be read counts as busy. A tab Jig did not record
 * is never touched, and nothing here fails a run: every step reports what it
 * did and the run goes on.
 *
 *   bun orca-tabs.ts close <handle> <pid>
 *
 * is the detached closer: it waits until `<pid>` has exited, then closes the
 * recorded tab `<handle>` if it is idle.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runMain } from "./cli.ts";
import { errnoCode, swallow } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { orcaEnvelope, type OrcaRunner, runOrca } from "./orca.ts";
import { type ProcessRow, processTable } from "./process-table.ts";

type Env = Record<string, string | undefined>;

/** One run tab, as its opener recorded it. */
export interface RunTab {
  version: 1;
  handle: string;
  tabId: string | null;
  /** The login shell Orca started in the tab, by PID and start time. */
  shellPid: number;
  shellStart: string;
  worktree: string;
  /** What the run is for: `pr:<number>` or `item:<key>`. */
  subject: string;
  title: string;
  /** The Orca command the tab was opened with, which closes it too. */
  orca: string;
  openedAt: string;
}

/** What the steps here read and call; tests replace each. */
export interface RunTabDeps {
  root: string;
  orca: OrcaRunner;
  table: () => Promise<ProcessRow[] | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Where run tabs are recorded: `JIG_ORCA_TABS_DIR`, else under the machine's Jig state. */
function tabsRoot(env: Env = process.env): string {
  const dir = env.JIG_ORCA_TABS_DIR?.trim();
  return dir || join(homedir(), ".local", "state", "jig", "orca-tabs");
}

export function defaultRunTabDeps(env: Env = process.env): RunTabDeps {
  return {
    root: tabsRoot(env),
    orca: runOrca,
    table: () => processTable(),
    now: Date.now,
    sleep: (ms) => new Promise((settle) => setTimeout(settle, ms)),
  };
}

/**
 * The variables a run tab's command carries: the store the opener records
 * into (the tab's shell does not inherit the opener's environment), and a
 * note that the opener will record the tab, so the run's end waits briefly
 * for the record instead of finding none.
 */
export function runTabEnv(env: Env = process.env): string[] {
  const dir = env.JIG_ORCA_TABS_DIR?.trim();
  return [
    `${PENDING_VAR}=1`,
    ...(dir ? [`JIG_ORCA_TABS_DIR=${resolve(dir)}`] : []),
  ];
}

const PENDING_VAR = "JIG_ORCA_TAB_PENDING";

/** How long a run's end waits for its opener to record the tab. */
const REGISTRATION_WAIT_MS = 10_000;

/** The subject of a run on a pull request. */
export function prSubject(pr: number | string): string {
  return `pr:${pr}`;
}

/**
 * Whether a drive that exited `code` leaves nothing for a person, so its tab
 * closes: converged, merged or closed, taken over, re-armable (quota-parked,
 * not judgeable yet), stopped or paused by a person, or refused because
 * another driver holds the pull request. A park, any other exit and a
 * signal keep the tab.
 */
export function driveExitClosesTab(code: number | null): boolean {
  return code !== null && DRIVE_EXITS_CLOSING.has(code);
}

const DRIVE_EXITS_CLOSING: ReadonlySet<number> = new Set([
  0, 4, 5, 11, 13, 16, 18, 19, 20,
]);

/** The handle, tab and shell PID in `orca terminal create`'s result; null when it names no handle or PID. */
export function openedTab(
  result: Record<string, unknown>,
): { handle: string; tabId: string | null; shellPid: number } | null {
  const terminal = isRecord(result.terminal) ? result.terminal : result;
  const { handle, tabId, processId } = terminal;
  if (typeof handle !== "string" || handle === "") return null;
  if (typeof processId !== "number" || !Number.isSafeInteger(processId))
    return null;
  return {
    handle,
    tabId: typeof tabId === "string" ? tabId : null,
    shellPid: processId,
  };
}

/** A worktree path as both openers compare it: resolved, through its links where it exists. */
function treePath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    swallow(error, `${path} does not resolve; compared as written`);
    return resolve(path);
  }
}

function tabFile(root: string, handle: string): string {
  return join(root, `${handle.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function isRunTab(value: unknown): value is RunTab {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.handle === "string" &&
    typeof value.shellPid === "number" &&
    typeof value.shellStart === "string" &&
    typeof value.worktree === "string" &&
    typeof value.subject === "string" &&
    typeof value.orca === "string"
  );
}

function readTab(path: string): RunTab | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRunTab(parsed) ? parsed : null;
  } catch (error) {
    swallow(error, `run tab record ${path} does not read`);
    return null;
  }
}

/** Every run tab recorded under `root`; a record that does not read is left out. */
export function readRunTabs(root: string): RunTab[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readTab(join(root, name)))
    .filter((tab): tab is RunTab => tab !== null);
}

function forget(root: string, handle: string): void {
  rmSync(tabFile(root, handle), { force: true });
}

/**
 * Record the tab `orca terminal create` answered `result` for. Returns the
 * record, or why the tab is not recorded (it then stays open after its run).
 */
export async function recordRunTab(
  opened: {
    orca: string;
    result: Record<string, unknown>;
    worktree: string;
    subject: string;
    title: string;
  },
  deps: Pick<RunTabDeps, "root" | "table" | "now">,
): Promise<{ tab: RunTab } | { unrecorded: string }> {
  const tab = openedTab(opened.result);
  if (tab === null)
    return {
      unrecorded: "Orca's answer names no terminal handle and shell PID",
    };
  const rows = await deps.table();
  const shell = rows?.find((row) => row.pid === tab.shellPid);
  if (shell === undefined || shell.start === "")
    return {
      unrecorded: `the tab's shell (PID ${tab.shellPid}) is not in the process table`,
    };
  const record: RunTab = {
    version: 1,
    ...tab,
    shellStart: shell.start,
    worktree: treePath(opened.worktree),
    subject: opened.subject,
    title: opened.title,
    orca: opened.orca,
    openedAt: new Date(deps.now()).toISOString(),
  };
  try {
    mkdirSync(deps.root, { recursive: true });
    const path = tabFile(deps.root, tab.handle);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    return {
      unrecorded: `the record could not be written (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { tab: record };
}

/** Whether the tab's shell is still the recorded one and has no child process. */
export function tabState(
  tab: RunTab,
  rows: ProcessRow[],
): "idle" | "busy" | "gone" {
  const shell = rows.find((row) => row.pid === tab.shellPid);
  if (shell === undefined || shell.start !== tab.shellStart) return "gone";
  const child = rows.some(
    (row) => row.ppid === tab.shellPid && !row.stat.startsWith("Z"),
  );
  return child ? "busy" : "idle";
}

/** How closing one tab ended. */
export type CloseOutcome = "closed" | "busy" | "gone" | { failed: string };

/**
 * Close `tab` through Orca if it is idle. A tab whose shell is gone, or that
 * Orca no longer knows, has its record dropped: Orca cannot close it by its
 * handle any more.
 */
export async function closeRunTab(
  tab: RunTab,
  deps: Pick<RunTabDeps, "root" | "orca" | "table">,
): Promise<CloseOutcome> {
  const rows = await deps.table();
  if (rows === null) return "busy";
  const state = tabState(tab, rows);
  if (state === "gone") {
    forget(deps.root, tab.handle);
    return "gone";
  }
  if (state === "busy") return "busy";
  const done = await deps.orca(tab.orca, [
    "terminal",
    "close",
    "--terminal",
    tab.handle,
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (done.code === 0 && envelope?.ok === true) {
    forget(deps.root, tab.handle);
    return "closed";
  }
  if (envelope?.ok === false && envelope.code === "terminal_handle_stale") {
    forget(deps.root, tab.handle);
    return "gone";
  }
  return {
    failed: `orca terminal close (exit ${done.code}): ${(done.stdout || done.stderr).trim().slice(0, 200)}`,
  };
}

function outcomeText(outcome: CloseOutcome): string {
  return typeof outcome === "string" ? outcome : outcome.failed;
}

/**
 * Close the earlier run tabs for `subject` in `worktree`, keeping `except`
 * (the tab just opened). Returns one line per tab it looked at.
 */
export async function closePreviousTabs(
  run: { worktree: string; subject: string; except: string },
  deps: Pick<RunTabDeps, "root" | "orca" | "table">,
  until: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const worktree = treePath(run.worktree);
  const earlier = readRunTabs(deps.root).filter(
    (tab) =>
      tab.worktree === worktree &&
      tab.subject === run.subject &&
      tab.handle !== run.except,
  );
  const lines: string[] = [];
  for (const tab of earlier) {
    if (Date.now() >= until) {
      lines.push(
        `earlier run tab ${tab.handle} (${tab.title}): left, out of time`,
      );
      continue;
    }
    lines.push(
      `earlier run tab ${tab.handle} (${tab.title}): ${outcomeText(await closeRunTab(tab, deps))}`,
    );
  }
  return lines;
}

const POLL_MS = 250;

const SELF = import.meta.path;

/**
 * Start the detached closer for `tab`, which waits for `pid` to exit first.
 * It writes what it did, and any failure, to `closer.log` beside the records.
 */
function startCloser(tab: RunTab, pid: number, root: string): void {
  mkdirSync(root, { recursive: true });
  const log = openSync(join(root, "closer.log"), "a");
  try {
    const child = spawn(
      process.execPath,
      ["--no-env-file", SELF, "close", tab.handle, String(pid)],
      // Its own session, so closing the tab does not end the closer, and a
      // directory with no bunfig.toml of a consumer's in it.
      {
        cwd: import.meta.dir,
        detached: true,
        env: { ...process.env, JIG_ORCA_TABS_DIR: root },
        stdio: ["ignore", log, log],
      },
    );
    // A spawn that fails later reports itself here, never as a crash of the run.
    child.on("error", (error) => {
      console.error(
        `run tab ${tab.handle}: its closer failed (${error.message})`,
      );
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * Called by a run tab's own command as it ends: when `closes` (the run left
 * nothing for a person), closes the tab once this process has exited, else
 * leaves it open. Returns a line for the run's log; null when this process
 * is not a recorded tab's own command (a person's tab, a run under another
 * wrapper, a test).
 */
export async function endOwnTab(
  closes: boolean,
  root: string = tabsRoot(),
  self: { pid: number; ppid: number } = process,
  start: (tab: RunTab, pid: number, root: string) => void = startCloser,
  wait: {
    pending: boolean;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  } = {
    pending: process.env[PENDING_VAR] === "1",
    now: Date.now,
    sleep: (ms) => new Promise((settle) => setTimeout(settle, ms)),
  },
): Promise<string | null> {
  const find = () => readRunTabs(root).find((t) => t.shellPid === self.ppid);
  let tab = find();
  // The opener records the tab after Orca has started the run, so a run that
  // ends quickly can get here first; wait for the record when one is coming.
  const deadline = wait.now() + REGISTRATION_WAIT_MS;
  while (tab === undefined && wait.pending && wait.now() < deadline) {
    await wait.sleep(POLL_MS);
    tab = find();
  }
  if (tab === undefined) return null;
  const named = `run tab ${tab.handle} (${tab.title})`;
  if (!closes) return `${named} stays open: the run ended needing a person`;
  try {
    start(tab, self.pid, root);
  } catch (error) {
    return `${named} stays open: its closer did not start (${error instanceof Error ? error.message : String(error)})`;
  }
  return `${named} closes once this run has exited`;
}

/** How long the closer waits for the run to exit and its shell to settle. */
const CLOSER_WAIT_MS = 15_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function childPids(tab: RunTab, rows: ProcessRow[]): number[] {
  return rows
    .filter((row) => row.ppid === tab.shellPid && !row.stat.startsWith("Z"))
    .map((row) => row.pid);
}

/**
 * The detached closer: wait for `pid` to exit, then close the tab once its
 * shell is idle. The closer starts while the run is still the shell's
 * foreground command, so a child of the shell it did not see then is a
 * person's new work: it stops there and leaves the tab.
 */
async function closeAfterExit(
  handle: string,
  pid: number,
  deps: RunTabDeps,
  isAlive: (pid: number) => boolean = alive,
): Promise<CloseOutcome | "unrecorded"> {
  const tab = readTab(tabFile(deps.root, handle));
  if (tab === null) return "unrecorded";
  const first = await deps.table();
  const known = new Set(first === null ? [] : childPids(tab, first));
  const deadline = deps.now() + CLOSER_WAIT_MS;
  while (isAlive(pid) && deps.now() < deadline) await deps.sleep(POLL_MS);
  for (;;) {
    const rows = await deps.table();
    if (rows !== null && childPids(tab, rows).some((p) => !known.has(p)))
      return "busy";
    const outcome = await closeRunTab(tab, deps);
    if (outcome !== "busy" || deps.now() >= deadline) return outcome;
    await deps.sleep(POLL_MS);
  }
}

async function closerMain(): Promise<number> {
  const [verb, handle, pid] = process.argv.slice(2);
  if (verb !== "close" || !handle || !Number.isSafeInteger(Number(pid))) {
    console.error("usage: orca-tabs.ts close <handle> <pid>");
    return 2;
  }
  const outcome = await closeAfterExit(
    handle,
    Number(pid),
    defaultRunTabDeps(),
  );
  console.error(
    `${new Date().toISOString()} run tab ${handle}: ${typeof outcome === "string" ? outcome : outcome.failed}`,
  );
  return outcome === "closed" || outcome === "gone" ? 0 : 1;
}

if (import.meta.main) runMain("orca-tabs.ts", closerMain);
