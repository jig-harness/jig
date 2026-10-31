/**
 * Orca's command-line tool, as the workspace tool calls it: where the command
 * is, how a paired server is named, and how one call is made. Every command
 * is run with `--json`, and its answer is read as the envelope the shared
 * reader (plugin/shared/orca-workspace/envelope.ts) describes.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type OrcaEnvelope,
  OrcaError,
  orcaErrorText,
  parseOrcaEnvelope,
} from "../../plugin/shared/orca-workspace/envelope.ts";
import type { OpenPort } from "../../plugin/shared/orca-workspace/port.ts";
import { type Context, output } from "../herdr/runner.ts";
import type { OrcaTarget, Workspace } from "./runner.ts";

export {
  type OrcaEnvelope,
  orcaErrorText,
  parseOrcaEnvelope,
  recordOf,
  textOf,
} from "../../plugin/shared/orca-workspace/envelope.ts";

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

/**
 * The port the shared open rules (plugin/shared/orca-workspace/) run through:
 * git and the hooks on the workspace's host, Orca's calls through its
 * command on this machine.
 */
export function portOf(ws: Workspace): OpenPort {
  return {
    host: ws.host,
    runHook: ws.runHook,
    orcaCall: <T>(args: string[], what: string) => orcaCall<T>(ws, args, what),
    where: onServer(ws.target),
  };
}

export type { Context };
