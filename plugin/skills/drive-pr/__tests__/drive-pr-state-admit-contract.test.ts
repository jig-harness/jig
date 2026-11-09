import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state admit session contract", () => {
  const { stateDirFor, state, liveSession, awaitPidGone } =
    createStateDurabilityFixtures();

  it("help names exit 2 for an invalid explicit session", async () => {
    const result = await state(stateDirFor("admit-help"), []);
    expectSpawnExit(result, 2);
    expect(result.stdout + result.stderr).toContain(
      "2 if $DRIVE_PR_SESSION is invalid or names a dead pid",
    );
  });

  it("refuses a malformed explicit session before admission", async () => {
    const result = await state(
      stateDirFor("admit-malformed"),
      ["admit", "999"],
      {
        DRIVE_PR_SESSION: "session-seven",
      },
    );
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("$DRIVE_PR_SESSION must be a process id");
  });

  it("refuses a dead explicit session before admission", async () => {
    const session = liveSession();
    const pid = session.pid;
    session.stop();
    await awaitPidGone(pid);
    const result = await state(stateDirFor("admit-dead"), ["admit", "999"], {
      DRIVE_PR_SESSION: String(pid),
    });
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain(`names pid ${pid}, which is not running`);
  });
});
