/**
 * The session runtime on Orca, for what starts a session: a terminal tab of
 * the workspace running the wrapper under its launch record (`orca terminal
 * create --worktree <selector> --title <tab title> --command <wrapper>`),
 * the tab titled by the port's convention (`jig dispatch · rearm #456`) and
 * the workspace's comment given the launch's dispatched mark first. The
 * wrapper binds the session to its account through the account's
 * configuration directory, with the credential variables removed, and its
 * claim on the record keeps a retried launch from starting a second
 * session. Each call runs under its deadline, and an answer past it is
 * lost, never read as a refusal.
 *
 * A headless pass is the wrapper's drive. An interactive session is the
 * wrapper's session of the account's agent (Claude Code or Codex, as the
 * account's vendor says); its receipt names the agent by the id `orca
 * worktree ps` reports it under, the terminal's tab and pane
 * (`<tabId>:<leafId>`), read back with `orca terminal show`. Orca still
 * reports that it cannot bind an interactive session (`orca.ts` says why),
 * so the tick never asks for one.
 *
 * The tab is recorded as a run tab (`shared/orca-tabs.ts`), so the wrapper
 * closes it when its run ends with nothing for a person, and the launch
 * closes the earlier idle run tabs of the same pull request or item in the
 * workspace. Neither holds a launch back: the receipt says what happened.
 */
import { resolve } from "node:path";
import { shellQuote } from "../../../shared/cli.ts";
import { orcaCommandOrInstalled, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import {
  closePreviousTabs,
  defaultRunTabDeps,
  runTabEnv,
  prSubject,
  recordRunTab,
} from "../../../shared/orca-tabs.ts";
import { readRecord } from "../launches.ts";
import { markComment } from "./orca-comment.ts";
import type { LaunchStage, RuntimeReceipt } from "./port.ts";

const RUN_TS = resolve(import.meta.dir, "../../run.ts");
const BUNFIG = resolve(import.meta.dir, "../../bunfig.toml");

/**
 * The command line a launched terminal runs: the wrapper under its record,
 * told by when the launch (`until`, epoch ms) will have recorded its tab.
 */
function wrapperCommand(record: string, token: string, until: number): string {
  return [
    "env",
    ...runTabEnv(process.env, until),
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    RUN_TS,
    record,
    token,
  ]
    .map(shellQuote)
    .join(" ");
}

/** The command Orca's CLI runs as. */
function orcaBinary(): string {
  return orcaCommandOrInstalled(process.env);
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The terminal handle in `terminal create`'s answer, if it names one. */
function handleOf(result: unknown): string | null {
  const terminal = isRecord(result) ? result.terminal : undefined;
  const handle = isRecord(terminal) ? terminal.handle : undefined;
  return typeof handle === "string" && handle !== "" ? handle : null;
}

/**
 * The agent id `orca worktree ps` reports for the session in a terminal:
 * its tab and pane, `<tabId>:<leafId>`, as `orca terminal show` gives them.
 */
async function agentIdOf(
  handle: string,
  timeoutMs: number,
): Promise<string | null> {
  const done = await run(
    [orcaBinary(), "terminal", "show", "--terminal", handle, "--json"],
    { timeoutSec: seconds(timeoutMs), stderr: "pipe" },
  );
  const envelope = orcaEnvelope(done.stdout);
  if (done.code !== 0 || envelope?.ok !== true) return null;
  const result = envelope.result;
  const terminal = isRecord(result) ? result.terminal : undefined;
  if (!isRecord(terminal)) return null;
  const { tabId, leafId } = terminal;
  return typeof tabId === "string" && typeof leafId === "string"
    ? `${tabId}:${leafId}`
    : null;
}

/**
 * Start the stage's session in `workspace`, after adding the stage's
 * dispatched mark to the workspace's comment. The key is the launch
 * record's token: a retry calls this again with the same record and key,
 * and the wrapper's claim on the record keeps a second terminal from
 * starting a second session. A mark that cannot be written does not hold
 * the launch back: the launch record keeps the mark, and the receipt says
 * why the comment lacks it.
 */
export async function orcaLaunch(
  workspace: { id: string; path: string },
  stage: LaunchStage,
  key: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  // One timeout covers the whole launch, as the launcher reserves: the mark
  // takes at most a third of it and the terminal what is left.
  const until = Date.now() + timeoutMs;
  const unmarked = await markComment(
    workspace.path,
    stage.mark,
    Math.floor(timeoutMs / 3),
  );
  // The mark can spend the launch's whole timeout: no terminal starts past it.
  if (until - Date.now() <= 0)
    return {
      ok: false,
      detail: `the launch's ${seconds(timeoutMs)}s were spent marking the workspace; no terminal was created`,
    };
  const receipt = await startTerminal(workspace, stage, key, until);
  return unmarked === null
    ? receipt
    : {
        ...receipt,
        detail: `${receipt.detail}; the workspace's comment does not carry the dispatched mark: ${unmarked}`,
      };
}

/** `orca terminal create` running the wrapper under the record, in a tab titled for the stage. */
async function startTerminal(
  workspace: { id: string; path: string },
  stage: LaunchStage,
  key: string,
  until: number,
): Promise<RuntimeReceipt> {
  const timeoutMs = Math.max(1, until - Date.now());
  const done = await run(
    [
      orcaBinary(),
      "terminal",
      "create",
      "--worktree",
      `path:${workspace.path}`,
      "--title",
      stage.title,
      "--command",
      wrapperCommand(stage.record, key, until),
      "--json",
    ],
    { timeoutSec: seconds(timeoutMs), stderr: "pipe" },
  );
  if (done.timedOut)
    return {
      ok: false,
      lost: true,
      detail: `orca terminal create gave no answer within ${seconds(timeoutMs)}s`,
    };
  const envelope = orcaEnvelope(done.stdout);
  if (done.code === 0 && envelope?.ok === true) {
    const tabNote = await runTab(workspace, stage, envelope.result, until);
    const detail = `orca terminal create: ${JSON.stringify(envelope.result).slice(0, 300)}${tabNote}`;
    if (stage.kind === "headless") return { ok: true, detail };
    const handle = handleOf(envelope.result);
    const left = until - Date.now();
    const agentId =
      handle === null || left <= 0 ? null : await agentIdOf(handle, left);
    return agentId === null
      ? {
          ok: true,
          detail: `${detail}; the agent's id could not be read back, so the record holds its slot by its wrapper alone`,
        }
      : { ok: true, detail, agentId };
  }
  // An answer that is not Orca's envelope says nothing about what started.
  if (envelope === null)
    return {
      ok: false,
      lost: true,
      detail: `orca terminal create exited ${done.code} without an answer: ${(done.stderr || done.stdout).trim().slice(0, 200)}`,
    };
  return {
    ok: false,
    detail: `orca terminal create refused it (${envelope.ok ? "exit" : (envelope.code ?? "no code")}, exit ${done.code})`,
  };
}

/** What a launch record's run is for, as run tabs name it; null when the record does not read. */
function subjectOf(record: string): string | null {
  const launch = readRecord(record);
  if (launch === null) return null;
  if (launch.pr !== null) return prSubject(launch.pr);
  return launch.item === null ? null : `item:${launch.item}`;
}

/**
 * Record the stage's tab as a run tab and close the earlier ones of its pull
 * request or item; returns what happened, for the receipt's detail.
 */
async function runTab(
  workspace: { path: string },
  stage: LaunchStage,
  result: Record<string, unknown>,
  until: number,
): Promise<string> {
  try {
    return await recordAndCloseEarlier(workspace, stage, result, until);
  } catch (error) {
    return `; the tab's recording failed and it stays open after its run: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function recordAndCloseEarlier(
  workspace: { path: string },
  stage: LaunchStage,
  result: Record<string, unknown>,
  until: number,
): Promise<string> {
  const subject = subjectOf(stage.record);
  if (subject === null)
    return "; the tab is not recorded as a run tab: its launch record does not read";
  if (Date.now() >= until)
    return "; the tab stays open after its run: the launch's time was spent before it could be recorded";
  const tabs = defaultRunTabDeps();
  const recorded = await recordRunTab(
    {
      orca: orcaBinary(),
      result,
      worktree: workspace.path,
      subject,
      title: stage.title,
    },
    tabs,
    until,
  );
  if ("unrecorded" in recorded)
    return `; the tab stays open after its run, since it is not recorded: ${recorded.unrecorded}`;
  const closed = await closePreviousTabs(
    { worktree: workspace.path, subject, except: recorded.tab.handle },
    tabs,
    until,
  );
  return closed.length === 0 ? "" : `; ${closed.join("; ")}`;
}
