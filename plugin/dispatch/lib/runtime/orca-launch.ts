/**
 * The session runtime on Orca, for what starts something: `launch` of a
 * headless pass as a terminal tab of the pull request's workspace running
 * the wrapper (`orca terminal create --worktree <selector> --title <stage>
 * --command <wrapper>`), and `openWorkspace` as `orca worktree create` with
 * the pull request linked, on the Orca workspace tool's own rules for
 * opening a branch's workspace (`shared/orca-workspace/`). Each runs under
 * its deadline, and an answer past it is lost, never read as a refusal.
 */
import { resolve } from "node:path";
import { shellQuote } from "../../../shared/cli.ts";
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { run } from "../../../shared/proc.ts";
import type { LaunchStage, RuntimeReceipt } from "./port.ts";

const RUN_TS = resolve(import.meta.dir, "../../run.ts");
const BUNFIG = resolve(import.meta.dir, "../../bunfig.toml");

/** The command line a headless pass's terminal runs: the wrapper under its record. */
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

/**
 * Start a headless pass in `workspace`. The key is the launch record's
 * token: a retry calls this again with the same record and key, and the
 * wrapper's claim on the record keeps a second terminal from starting a
 * second pass.
 */
export async function orcaLaunch(
  workspace: { id: string; path: string },
  stage: LaunchStage,
  key: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  if (stage.kind !== "headless")
    return {
      ok: false,
      detail:
        "an interactive launch is not built yet (build step 4): no Orca agent launch is shown to bind its account",
    };
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
  if (done.code === 0 && envelope?.ok === true)
    return {
      ok: true,
      detail: `orca terminal create: ${JSON.stringify(envelope.result).slice(0, 300)}`,
    };
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
