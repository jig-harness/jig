import { join } from "node:path";

import { SCRIPTS } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export function createStatusEscalationFixtures() {
  async function driveState(
    stateDir: string,
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), exitCode };
  }
  return { driveState };
}
