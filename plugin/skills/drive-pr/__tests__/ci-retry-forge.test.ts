/** Exercise the live forge adapter's exact-head and hold witnesses against the fixture forge. */
import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  binDir,
  gitCleanEnv,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { skipLongDriveFixture } from "./drive-loop-harness.ts";
import { driveDbInstance } from "../scripts/lib/state/db.ts";

useDrivePrSuite();

async function retry(
  opts: {
    state?: string;
    held?: boolean;
    runHead?: string;
    runStatus?: string;
    malformed?: boolean;
  } = {},
) {
  const head = scratchClean.head;
  const { dir, stateDir } = writeFixture(
    {
      threads: [],
      head,
      ...(opts.state === undefined ? {} : { prState: opts.state }),
      ...(opts.held === undefined ? {} : { ciHeld: opts.held }),
    },
    scratchClean.dir,
  );
  writeFileSync(
    join(dir, "run-41.json"),
    opts.malformed
      ? "?"
      : JSON.stringify({
          headSha: opts.runHead ?? head,
          attempt: 1,
          status: opts.runStatus ?? "completed",
        }),
  );
  const overlay = join(dir, "retry.yaml");
  writeFileSync(
    overlay,
    "ci:\n  hold_label: ci:hold\n  required_checks: [tests]\n",
  );
  const file = join(dir, "retry.ts");
  const adapter = join(
    import.meta.dir,
    "../scripts/lib/driver/ci-retry-forge.ts",
  );
  writeFileSync(
    file,
    `#!/usr/bin/env bun\nimport {failedCheckForge} from ${JSON.stringify(adapter)}; console.log(JSON.stringify(await failedCheckForge.retry("999", ${JSON.stringify(head)}, 41)));`,
    { mode: 0o755 },
  );
  const proc = Bun.spawn(scriptArgv(file), {
    cwd: scratchClean.dir,
    env: {
      ...gitCleanEnv(),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_STATE_DIR_IDENTITY: driveDbInstance(stateDir),
      JIG_OVERLAY: overlay,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
  return {
    answer: JSON.parse(stdout) as { ok: boolean; detail: string },
    sent: existsSync(join(dir, "reruns.log")),
  };
}

describe.skipIf(skipLongDriveFixture)("failed-check forge retry", () => {
  it("retries a completed run on the open unheld exact head", async () => {
    const result = await retry();
    expect(result.answer).toMatchObject({ ok: true });
    expect(result.sent).toBe(true);
  });
  it.each([
    { state: "CLOSED" },
    { held: true },
    { runHead: "b".repeat(40) },
    { runStatus: "in_progress" },
    { malformed: true },
  ])("sends no retry when a witness refuses: %j", async (opts) => {
    const result = await retry(opts);
    expect(result.answer.ok).toBe(false);
    expect(result.sent).toBe(false);
  });
});
