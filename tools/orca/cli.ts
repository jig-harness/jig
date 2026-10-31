/**
 * Orca's command-line tool, as the workspace tool calls it: where the command
 * is, how a paired server is named, and how its JSON answers are read.
 *
 * Every command is run with `--json` and answers one envelope,
 * `{ ok: true, result }` or `{ ok: false, error: { code, message } }`, on
 * standard output, with exit 1 on an error. An answer that is neither is a
 * failure of the call, never read as a result.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isRecord } from "../../lib/record.ts";
import { swallow } from "../../plugin/shared/errors.ts";
import { orcaErrorText } from "../../plugin/shared/orca.ts";
import { type Context, output } from "../herdr/runner.ts";
import { OrcaError, type OrcaTarget, type Workspace } from "./runner.ts";

/** Where the macOS app keeps its command when nothing on `PATH` names it. */
export const MACOS_APP_COMMAND =
  "/Applications/Orca.app/Contents/Resources/bin/orca";

/** The first directory of `pathEnv` holding `name`, as a path; null when none. */
function findOnPath(
  name: string,
  pathEnv: string | undefined,
  exists: (path: string) => boolean,
): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter))
    if (dir !== "" && exists(join(dir, name))) return join(dir, name);
  return null;
}

/**
 * The command that runs Orca's tool on this machine. A terminal Orca opened
 * names the directory of its own copy (`ORCA_CLI_BIN_DIR`), which matches the
 * running app; otherwise the one on `PATH`, which is `orca-ide` on Linux,
 * where `orca` is the screen reader; otherwise the macOS app's own copy.
 */
export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const name = platform === "linux" ? "orca-ide" : "orca";
  const binDir = env.ORCA_CLI_BIN_DIR?.trim();
  if (binDir && exists(join(binDir, name))) return join(binDir, name);
  const onPath = findOnPath(name, env.PATH, exists);
  if (onPath !== null) return onPath;
  if (platform === "darwin" && exists(MACOS_APP_COMMAND))
    return MACOS_APP_COMMAND;
  throw new OrcaError(
    `Orca's command-line tool (${name}) was not found on PATH${platform === "darwin" ? ` or at ${MACOS_APP_COMMAND}` : ""}; install Orca (https://www.onorca.dev/docs/install) and register its command (Settings → General → Orca CLI)`,
  );
}

/** The whole command line of one call: the command, its arguments, the server, `--json`. */
export function orcaArgv(target: OrcaTarget, args: string[]): string[] {
  return [
    target.command,
    ...args,
    ...(target.environment === undefined
      ? []
      : ["--environment", target.environment]),
    "--json",
  ];
}

/**
 * What a command answers: a result, or an error. Anything else that comes
 * back, `{ ok: false }` with no error or a result with no `ok`, is not an
 * answer this tool acts on, so a malformed response never passes as a
 * success or as a named failure.
 */
export type OrcaEnvelope<T> =
  | { ok: true; result: T | undefined }
  | { ok: false; error: { code?: string; message?: string } };

/** The well-formed envelope in a command's output, or null when it holds none. */
export function parseOrcaEnvelope<T>(text: string): OrcaEnvelope<T> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    swallow(error, "orca output that starts like JSON but is not: no envelope");
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.ok === true) return { ok: true, result: parsed.result as T };
  if (parsed.ok === false && isRecord(parsed.error)) {
    const { code, message } = parsed.error;
    return {
      ok: false,
      error: {
        ...(typeof code === "string" ? { code } : {}),
        ...(typeof message === "string" ? { message } : {}),
      },
    };
  }
  return null;
}

/**
 * The envelope a command answered with, error included; throws only when
 * there is none. `what` names the call in messages.
 */
export function orcaCall<T>(
  ws: Workspace,
  args: string[],
  what: string,
  timeoutMs?: number,
): OrcaEnvelope<T> {
  const result = ws.orca.run(
    orcaArgv(ws.target, args),
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  const envelope = parseOrcaEnvelope<T>(result.stdout);
  if (envelope !== null && !envelope.ok) return envelope;
  if (result.status !== 0)
    throw new OrcaError(
      `${what} failed (exit ${result.status}): ${output(result)}`,
    );
  if (envelope === null)
    throw new OrcaError(`${what}: unreadable output: ${output(result)}`);
  return envelope;
}

export { orcaErrorText };

/** The result of a command that must succeed. */
export function orcaJson<T>(
  ws: Workspace,
  args: string[],
  what: string,
  timeoutMs?: number,
): T {
  const envelope = orcaCall<T>(ws, args, what, timeoutMs);
  if (!envelope.ok)
    throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
  if (envelope.result === undefined)
    throw new OrcaError(`${what}: empty result`);
  return envelope.result;
}

/** Where a server runs, for messages: "on <environment>" or nothing. */
export function onServer(target: OrcaTarget): string {
  return target.environment === undefined ? "" : ` on ${target.environment}`;
}

/** Narrow a value read from Orca to a record, or throw naming the call. */
export function recordOf(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new OrcaError(`${what}: unexpected answer`);
  return value;
}

/** A string field of a record read from Orca, or throw naming the call. */
export function textOf(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "")
    throw new OrcaError(`${what}: no ${key} in the answer`);
  return value;
}

export type { Context };
