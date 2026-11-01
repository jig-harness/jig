/**
 * The session runtime on Orca, for what starts a session: a terminal tab of
 * the workspace running the wrapper under its launch record (`orca terminal
 * create --worktree <selector> --title <stage> --command <wrapper>`). The
 * wrapper binds the session to its account through the account's
 * configuration directory, with the credential variables removed, and its
 * claim on the record keeps a retried launch from starting a second
 * session. Each call runs under its deadline, and an answer past it is
 * lost, never read as a refusal.
 *
 * A headless pass is the wrapper's drive. An interactive session is the
 * wrapper's Claude Code session; its receipt names the agent by the id
 * `orca worktree ps` reports it under, the terminal's tab and pane
 * (`<tabId>:<leafId>`), read back with `orca terminal show`. Whether Orca's
 * status hooks report a session started this way as an agent is not shown
 * yet, so Orca reports that it cannot bind an interactive session
 * (`orca.ts`) and the tick never asks for one.
 */
import { resolve } from "node:path";
import { shellQuote } from "../../../shared/cli.ts";
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import type { LaunchStage, RuntimeReceipt } from "./port.ts";

const RUN_TS = resolve(import.meta.dir, "../../run.ts");
const BUNFIG = resolve(import.meta.dir, "../../bunfig.toml");

/** The command line a launched terminal runs: the wrapper under its record. */
function wrapperCommand(record: string, token: string): string {
  return [
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
  return orcaCommand(process.env) ?? "orca";
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
 * Start the stage's session in `workspace`. The key is the launch record's
 * token: a retry calls this again with the same record and key, and the
 * wrapper's claim on the record keeps a second terminal from starting a
 * second session.
 */
export async function orcaLaunch(
  workspace: { id: string; path: string },
  stage: LaunchStage,
  key: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
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
      wrapperCommand(stage.record, key),
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
    const detail = `orca terminal create: ${JSON.stringify(envelope.result).slice(0, 300)}`;
    if (stage.kind === "headless") return { ok: true, detail };
    const handle = handleOf(envelope.result);
    const agentId = handle === null ? null : await agentIdOf(handle, timeoutMs);
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
