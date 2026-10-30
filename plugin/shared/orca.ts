/**
 * Orca's command line, as the skills that act in an Orca workspace call it:
 * which command to run, how to run it with a deadline, and how to read the
 * JSON envelope every `--json` call answers with.
 *
 * Orca (https://www.onorca.dev) runs agents in worktrees it manages, shows
 * them as cards on a workspace board and opens terminal tabs in them. A
 * session runs under Orca when a terminal Orca opened started it: Orca then
 * puts its command in `ORCA_CLI_COMMAND`, or its directory in
 * `ORCA_CLI_BIN_DIR`. Outside Orca nothing here makes a call.
 */
import { join } from "node:path";
import { swallow } from "./errors.ts";
import { detectHarness } from "./harness.ts";
import { run } from "./proc.ts";

type Env = Record<string, string | undefined>;

/** Seconds one Orca call may take. */
const ORCA_CALL_TIMEOUT_SEC = 20;

/** Runs Orca's command with `args`; the seam tests replace. */
export type OrcaRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The runner that spawns Orca's command, bounded by `ORCA_CALL_TIMEOUT_SEC`. */
export const runOrca: OrcaRunner = (command, args) =>
  run([command, ...args], { timeoutSec: ORCA_CALL_TIMEOUT_SEC });

/**
 * Orca's command when this session runs in a terminal Orca opened; null
 * otherwise. From the directory alone, the command is the one Orca installs
 * there: `orca-ide` on Linux, `orca` elsewhere.
 */
export function orcaCommand(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const command = env.ORCA_CLI_COMMAND?.trim();
  if (command) return command;
  const dir = env.ORCA_CLI_BIN_DIR?.trim();
  return dir ? join(dir, platform === "linux" ? "orca-ide" : "orca") : null;
}

/**
 * Orca's command when the session can open a terminal tab through it: the
 * harness runs under Orca (`detectHarness`'s wrapper) and Orca named its
 * command. Null anywhere else.
 */
export function orcaTabCommand(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (detectHarness(env)?.wrapper !== "orca") return null;
  return orcaCommand(env, platform);
}

/** One Orca call's answer, read from its JSON envelope. */
export type OrcaEnvelope =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string | null };

interface RawEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

/** `stdout` parsed as a JSON object; null when it is not one. */
function parsedObject(stdout: string): RawEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as RawEnvelope)
      : null;
  } catch (error) {
    swallow(error, "orca output that is not JSON: no envelope");
    return null;
  }
}

/** Orca's JSON envelope in `stdout`; null when there is none. */
export function orcaEnvelope(stdout: string): OrcaEnvelope | null {
  const raw = parsedObject(stdout);
  if (raw?.ok === true && typeof raw.result === "object" && raw.result !== null)
    return { ok: true, result: raw.result as Record<string, unknown> };
  if (raw?.ok !== false) return null;
  const code = raw.error?.code;
  return { ok: false, code: typeof code === "string" ? code : null };
}

/** The `result` of a call that exited 0 with a successful envelope; null for anything else. */
export function orcaResult(done: {
  code: number;
  stdout: string;
}): Record<string, unknown> | null {
  const envelope = orcaEnvelope(done.stdout);
  return done.code === 0 && envelope?.ok === true ? envelope.result : null;
}

/** A failed call's exit code and first output, for a warning. */
export function orcaFailure(done: {
  code: number;
  stdout: string;
  stderr: string;
}): string {
  return `(exit ${done.code}): ${(done.stdout || done.stderr).trim().slice(0, 300)}`;
}
