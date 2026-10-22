/**
 * The workspace tool's command lines, parsed in one place: the tool reads
 * its options here, and so does whatever bounds a run of it from outside
 * (`--host`'s SSH session), so both read the same values from the same
 * arguments, equals forms and repeated options included.
 */
import { strictOptions } from "../../lib/cli.ts";
import { HerdrError } from "./runner.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./spawn.ts";

export const USAGE = `usage:
  workspace.ts [--host <ssh-target>] open --repo <clone> --branch <name> [--reuse-prefix <text>] [--base <ref>]
      [--label <text>] [--agent <kind>] [--no-agent] [--prompt <text> --key <key>] [--wait-timeout-ms <ms>] [--json]
  workspace.ts [--host <ssh-target>] remove --repo <clone> --branch <name> [--force]
  workspace.ts created`;

const MAX_WAIT_TIMEOUT_MS = 60 * 60_000;

export class UsageError extends HerdrError {
  override name = "UsageError";
}

function parseWaitTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_WAIT_TIMEOUT_MS)
    throw new UsageError(
      `--wait-timeout-ms must be a whole number of milliseconds from 1 to ${MAX_WAIT_TIMEOUT_MS}\n${USAGE}`,
    );
  return ms;
}

export interface OpenOptions {
  repo: string;
  branch: string;
  reusePrefix?: string;
  base?: string;
  label?: string;
  agent?: string;
  noAgent: boolean;
  prompt?: string;
  key?: string;
  waitTimeoutMs: number;
  json: boolean;
}

/** `open`'s arguments; throws `UsageError` for any the tool refuses. */
export function parseOpen(args: string[]): OpenOptions {
  const { values } = strictOptions(
    {
      args,
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        "reuse-prefix": { type: "string" },
        base: { type: "string" },
        label: { type: "string" },
        agent: { type: "string" },
        "no-agent": { type: "boolean" },
        prompt: { type: "string" },
        key: { type: "string" },
        "wait-timeout-ms": { type: "string" },
        json: { type: "boolean" },
      },
    },
    USAGE,
  );
  if (values.repo === undefined || values.branch === undefined)
    throw new UsageError(`open needs --repo and --branch\n${USAGE}`);
  if ((values.prompt === undefined) !== (values.key === undefined))
    throw new UsageError(`--prompt and --key go together\n${USAGE}`);
  const reusePrefix = values["reuse-prefix"];
  if (
    reusePrefix !== undefined &&
    (reusePrefix === "" || !values.branch.startsWith(reusePrefix))
  )
    throw new UsageError(
      `--reuse-prefix must be non-empty and start --branch\n${USAGE}`,
    );
  return {
    repo: values.repo,
    branch: values.branch,
    ...(reusePrefix === undefined ? {} : { reusePrefix }),
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.label === undefined ? {} : { label: values.label }),
    ...(values.agent === undefined ? {} : { agent: values.agent }),
    noAgent: values["no-agent"] ?? false,
    ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
    ...(values.key === undefined ? {} : { key: values.key }),
    waitTimeoutMs: parseWaitTimeout(values["wait-timeout-ms"]),
    json: values.json ?? false,
  };
}

export interface RemoveOptions {
  repo: string;
  branch: string;
  force: boolean;
}

/** `remove`'s arguments; throws `UsageError` for any the tool refuses. */
export function parseRemove(args: string[]): RemoveOptions {
  const { values } = strictOptions(
    {
      args,
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        force: { type: "boolean" },
      },
    },
    USAGE,
  );
  if (values.repo === undefined || values.branch === undefined)
    throw new UsageError(`remove needs --repo and --branch\n${USAGE}`);
  return {
    repo: values.repo,
    branch: values.branch,
    force: values.force ?? false,
  };
}
