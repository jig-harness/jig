/**
 * Running the agent tools' own commands for the plugin's install and update
 * (`harness.ts`, `scoped-installs.ts`): each bounded by
 * `JIG_SETUP_TIMEOUT_SECONDS`, printed before it runs when it changes
 * something, and failing as a `HarnessError` that names the command.
 */
import { spawnSync } from "node:child_process";
import { JigError } from "../shared/errors.ts";

export const PLUGIN = "jig";
export const MARKETPLACE = "jig";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

/** A request that cannot be carried out as given: the command line contradicts itself. */
export class UpgradeRequestError extends JigError<"contradictory-request"> {
  override name = "UpgradeRequestError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("contradictory-request", reason, options);
  }
}

/**
 * A harness that could not be used: a tool command that failed, stalled or
 * answered something unreadable, a named harness not on `PATH`, or a
 * marketplace registered from a source other than the one asked for.
 */
export class HarnessError extends JigError<"harness-unusable"> {
  override name = "HarnessError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("harness-unusable", reason, options);
  }
}

/** Where progress lines go: standard output, or standard error when a report goes to standard output. */
export type Say = (line: string) => void;

/** Upper bound per tool command, so a stalled fetch cannot hold an upgrade forever. */
export function commandTimeoutMs(): number {
  const raw = process.env.JIG_SETUP_TIMEOUT_SECONDS;
  const seconds = raw === undefined || raw === "" ? 300 : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new UpgradeRequestError(
      `JIG_SETUP_TIMEOUT_SECONDS must be a positive number of seconds, got ${raw}`,
    );
  return seconds * 1000;
}

/** Runs one tool command, in `cwd` when given; given `say`, prints it first. */
export function run(
  command: string,
  args: string[],
  say?: Say,
  cwd?: string,
): string {
  say?.(
    `$ ${cwd === undefined ? "" : `(cd ${cwd}) `}${[command, ...args].join(" ")}`,
  );
  const timeout = commandTimeoutMs();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.error && code(result.error) === "ETIMEDOUT")
    throw new HarnessError(
      `${command} ${args.join(" ")} did not finish within ${timeout / 1000}s (JIG_SETUP_TIMEOUT_SECONDS)`,
    );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new HarnessError(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

export function json(command: string, args: string[]): unknown {
  const output = run(command, args);
  try {
    return JSON.parse(output);
  } catch {
    throw new HarnessError(
      `${command} ${args.join(" ")} printed unexpected output: ${output.slice(0, 200)}`,
    );
  }
}

export function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
