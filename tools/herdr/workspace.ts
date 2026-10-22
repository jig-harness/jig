#!/usr/bin/env bun
/**
 * Open and remove Herdr worktree workspaces, on this machine or on a host
 * reached over SSH.
 *
 * Usage:
 *   bun tools/herdr/workspace.ts [--host <ssh-target>] open --repo <clone> --branch <name>
 *       [--base <ref>] [--label <text>] [--agent <kind>] [--no-agent]
 *       [--prompt <text> --key <key>] [--wait-timeout-ms <ms>] [--json]
 *   bun tools/herdr/workspace.ts [--host <ssh-target>] remove --repo <clone> --branch <name> [--force]
 *   bun tools/herdr/workspace.ts created
 *
 * `open` creates the branch's worktree in the clone, or reattaches to the one
 * that has it, waits for the repository's create hook, starts the agent
 * (`claude` unless `--agent` names another Herdr agent kind) and, with
 * `--prompt`, sends it that first prompt once per `--key`. The base of a new
 * branch is the clone's `origin/HEAD` unless `--base` names one. `--json`
 * prints what was opened; progress goes to stderr.
 *
 * `remove` runs the repository's remove hook in the worktree, parks its
 * reflection findings and then removes it, refusing when either fails.
 *
 * `created` is the Herdr plugin event (tools/herdr/plugin): it runs the
 * repository's create hook in the worktree the event names.
 *
 * `--host` runs the command on that host instead; the host needs `bun`,
 * `git` and `herdr`, nothing from Jig. Each command ends itself at its own
 * limit (tools/herdr/limits.ts), and the whole SSH session is bounded by
 * that limit plus the connection around it. A path starting `~/` is resolved on
 * the machine the command runs on.
 *
 * Exit codes: 0 done; 1 the step failed (the message says what to do);
 * 2 usage.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  CLAIM_WAIT_MS,
  KICKOFF_KEY,
  type KickoffOutcome,
  kickoff,
  promptToken,
} from "./kickoff.ts";
import {
  createdWorktreePath,
  removeWorkspace,
  runCreateHook,
} from "./lifecycle.ts";
import {
  openLimitMs,
  removeLimitMs,
  TRANSPORT_MS,
  toolLimitMs,
} from "./limits.ts";
import {
  type OpenOptions,
  parseOpen,
  parseRemove,
  type RemoveOptions,
  USAGE,
  UsageError,
} from "./options.ts";
import { runToolOnHost } from "./remote.ts";
import { type Context, HerdrError, localContext, withLimit } from "./runner.ts";
import { type Spawned, spawnWorkspace } from "./spawn.ts";

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

export interface OpenReport {
  spawned: Spawned;
  kickoff: KickoffOutcome | null;
}

/** The kickoff's arguments, given `--prompt`: a key, a first line, an agent. */
function assertKickoffArgs(
  prompt: string,
  key: string | undefined,
  noAgent: boolean,
): void {
  if (promptToken(prompt) === "")
    throw new UsageError(
      `--prompt must start with a non-empty line, which is what a later open looks for in the agent's transcript\n${USAGE}`,
    );
  if (key !== undefined && !KICKOFF_KEY.test(key))
    throw new UsageError(`--key must match ${KICKOFF_KEY}\n${USAGE}`);
  if (noAgent)
    throw new UsageError(`--prompt needs an agent; drop --no-agent\n${USAGE}`);
}

async function open(ctx: Context, values: OpenOptions): Promise<number> {
  if (values.prompt !== undefined)
    assertKickoffArgs(values.prompt, values.key, values.noAgent);
  const repo = expandHome(values.repo);
  const spawned = spawnWorkspace(ctx, {
    repo,
    branch: values.branch,
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.label === undefined ? {} : { label: values.label }),
    kind: values.agent ?? "claude",
    noAgent: values.noAgent,
    waitTimeoutMs: values.waitTimeoutMs,
  });
  const report: OpenReport = {
    spawned,
    kickoff:
      values.prompt === undefined || values.key === undefined
        ? null
        : kickoff(ctx, spawned, {
            key: values.key,
            prompt: values.prompt,
            claimWaitMs: CLAIM_WAIT_MS,
          }),
  };
  if (values.json) console.log(JSON.stringify(report));
  else
    ctx.log(
      `✓ ${spawned.path} (workspace ${spawned.workspaceId}); attach: herdr`,
    );
  return 0;
}

async function remove(ctx: Context, values: RemoveOptions): Promise<number> {
  await removeWorkspace(ctx, { ...values, repo: expandHome(values.repo) });
  return 0;
}

function created(ctx: Context, args: string[]): number {
  if (args.length > 0)
    throw new UsageError(`created takes no arguments\n${USAGE}`);
  runCreateHook(ctx, createdWorktreePath(process.env.HERDR_PLUGIN_EVENT_JSON));
  return 0;
}

/** Run the command on the host named first, the whole session bounded. */
async function onHost([host, ...args]: string[]): Promise<number> {
  if (host === undefined)
    throw new UsageError(`--host needs a value\n${USAGE}`);
  const remote = await runToolOnHost(
    host,
    args,
    AbortSignal.timeout(toolLimitMs(args) + TRANSPORT_MS),
    (chunk) => process.stderr.write(chunk),
  );
  process.stdout.write(remote.stdout);
  return remote.status;
}

export async function main(
  argv: string[],
  ctx = localContext(),
): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "--host") return await onHost(args);
    // Each command ends itself at its limit, so a session bounded from
    // outside by the same limit never cuts a run the tool allows.
    if (command === "open") {
      const values = parseOpen(args);
      return await open(
        withLimit(ctx, openLimitMs(values.waitTimeoutMs)),
        values,
      );
    }
    if (command === "remove")
      return await remove(withLimit(ctx, removeLimitMs()), parseRemove(args));
    if (command === "created") return created(ctx, args);
  } catch (error) {
    if (error instanceof HerdrError && !(error instanceof UsageError)) {
      ctx.log(`ERROR: ${error.message}`);
      return 1;
    }
    throw error;
  }
  throw new UsageError(USAGE);
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
