import { type Context, budget } from "../../../shared/orca-workspace/runner.ts";
import { ghCall } from "../../../shared/proc.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import type { HeadReader } from "./orca-pr-head.ts";

/** The verification path uses the forge's ledger and hold, within its remaining workspace deadline. */
export function workspaceHeadReader(
  ctx: Context,
  send: typeof ghCall = ghCall,
): HeadReader {
  return async (argv, options) => {
    const remaining = budget(ctx, 120_000);
    // ghCall's minimum deadline is one second: below it, send nothing.
    if (remaining < 1000)
      return {
        status: -1,
        stdout: "",
        stderr:
          "[unreachable] the workspace deadline has less than one second left; no forge request sent",
      };
    const read = await send(argv.slice(1), {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stderr: "pipe",
      timeoutSec: remaining / 1000,
    });
    const failure = ghRunFailure(read);
    return {
      status: read.code,
      stdout: read.stdout,
      stderr:
        failure === null ? read.stderr : `[${failure.code}] ${failure.reason}`,
    };
  };
}
