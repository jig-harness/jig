/**
 * What opening an Orca workspace needs from its caller: where git and the
 * hooks run, how a hook is run, and how one Orca call is made. The Orca
 * workspace tool (tools/orca/) builds it from its two machines, this one and
 * a paired server's host over SSH; a caller with the clone on this machine
 * builds it from one local context.
 */
import { type OrcaEnvelope, OrcaError, orcaErrorText } from "./envelope.ts";
import { HOOK_TIMEOUT_MS } from "./limits.ts";
import { budget, type Context } from "./runner.ts";

/**
 * Runs a worktree hook (`hook`, a path in `worktree`) through `ctx`, with the
 * hook's output in the log; throws when it fails. `groupFile`, where the
 * runner supervises a process group, records the group so a failed run's
 * leftovers can be ended.
 */
export type HookRunner = (
  ctx: Context,
  worktree: string,
  hook: string,
  groupFile?: string,
) => void;

export interface OpenPort {
  /** Runs git and the hooks where the clone is. */
  host: Context;
  /** Runs a hook through `host`. */
  runHook: HookRunner;
  /**
   * One Orca call with `args`, run with `--json`: the envelope it answered
   * with, error included; throws only when there is none. `what` names the
   * call in messages.
   */
  orcaCall<T>(args: string[], what: string): OrcaEnvelope<T>;
  /** Where Orca runs, for messages: "" for this machine, " on <server>" for a paired one. */
  where: string;
}

/** The result of an Orca call that must succeed. */
export function orcaResult<T>(port: OpenPort, args: string[], what: string): T {
  const envelope = port.orcaCall<T>(args, what);
  if (!envelope.ok)
    throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
  if (envelope.result === undefined)
    throw new OrcaError(`${what}: empty result`);
  return envelope.result;
}

/**
 * Run a hook as one command in the worktree, bounded by the hook's limit,
 * its output logged line by line. Nothing supervises what the hook starts:
 * a child that outlives the call is left to the machine it runs on.
 */
export const boundedHook: HookRunner = (ctx, worktree, hook) => {
  const done = ctx.run([hook], {
    cwd: worktree,
    timeoutMs: budget(ctx, HOOK_TIMEOUT_MS),
  });
  for (const stream of [done.stdout, done.stderr])
    for (const line of stream.split("\n")) if (line !== "") ctx.log(line);
  if (done.status !== 0)
    throw new OrcaError(`${hook} failed (exit ${done.status})`);
};
