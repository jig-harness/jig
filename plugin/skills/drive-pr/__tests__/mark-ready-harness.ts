/** Runs mark-ready.ts for PR 999 against a fixture directory and state dir. */
import { join, delimiter } from "node:path";
import { SCRIPTS, binDir, scratchClean } from "./drive-pr-harness.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export async function markReady(
  dir: string,
  stateDir: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "mark-ready.ts"), "999", ...args),
    {
      cwd: scratchClean.dir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { outcome: stdout.trim(), stderr, exitCode };
}
