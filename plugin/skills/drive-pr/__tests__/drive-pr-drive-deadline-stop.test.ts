/**
 * drive-pr suite: what a pass deadline with its restarts spent records on its
 * stop, as a stall does: the tree it ran in and whether it left work there
 * no push carries, so a re-drive runs where the killed passes' work is.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { PASS_DEADLINE_EXIT } from "../scripts/lib/driver/settings.ts";
import {
  makeScratchRepo,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";

useDrivePrSuite();

/** The drive state's last stop event. */
async function lastStop(stateDir: string, cwd: string): Promise<unknown> {
  const r = await state(stateDir, ["get", "999"], cwd);
  const events = (JSON.parse(r.stdout) as { events?: unknown[] }).events;
  return (events ?? []).findLast(
    (e) => (e as { kind?: string }).kind === "stop",
  );
}

describe("drive.ts pass-deadline stop", () => {
  it("records on its stop the tree it ran in and whether it left work there", async () => {
    for (const dirty of [true, false]) {
      const repo = makeScratchRepo(`deadline-left-work-${String(dirty)}`);
      if (dirty) writeFileSync(join(repo.dir, "left.txt"), "a pass's edit\n");
      const { dir, stateDir } = writeFixture(
        {
          threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
          head: repo.head,
          reviewedSha: repo.head,
        },
        repo.dir,
      );
      const r = await runDriveIn(
        dir,
        stateDir,
        [
          "--no-head-sync",
          "--pass-timeout",
          "1",
          "--",
          "sh",
          "-c",
          ": pass for 999; sleep 60",
        ],
        repo.dir,
      );
      expectSpawnExit({ ...r, stdout: null }, PASS_DEADLINE_EXIT);
      expect(await lastStop(stateDir, repo.dir)).toMatchObject({
        cause: String(PASS_DEADLINE_EXIT),
        leftWork: dirty,
      });
      expect(await lastStop(stateDir, repo.dir)).toHaveProperty("tree");
    }
  }, 240_000);
});
