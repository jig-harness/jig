/**
 * drive-pr suite: what a stall stop repeats. The extra round's pass is told
 * what the tree holds, and the stop prints what that pass recorded, the
 * refusal that stops the round now, rather than what an earlier pass wrote
 * about a state that may no longer hold.
 */

import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeScratchRepo,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDrive, runDriveIn, state } from "./drive-loop-harness.ts";

useDrivePrSuite();

/**
 * A pass that acts on nothing. Before the stall notice it records an early
 * blocker; with the notice it echoes whether the notice names the tree's
 * contents, and records `extra` when given.
 */
function pass(extra: string | null): string[] {
  const handoff = '"$DRIVE_PR_HANDOFF_DIR/pr-drive-999.md"';
  return [
    "sh",
    "-c",
    [
      ": pass for 999",
      'case "$DRIVE_PR_PASS_NOTICE" in',
      "  STALLED*)",
      '    case "$DRIVE_PR_PASS_NOTICE" in *"What this tree holds now:"*) echo "pass for 999: NOTICE-NAMES-TREE" >&2 ;; esac',
      ...(extra === null
        ? []
        : [`    echo ${JSON.stringify(extra)} >> ${handoff}`]),
      "    ;;",
      "  *)",
      `    grep -q "Blocked: base-sync" ${handoff} || echo "Blocked: base-sync.ts exit 3, a merge left open." >> ${handoff}`,
      "    ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  ];
}

const fixture = () => ({
  threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
  head: scratchClean.head,
  reviewedSha: scratchClean.head,
});

describe("drive.ts stall stop", () => {
  it("prints the refusal the extra round's pass recorded, not an earlier pass's", async () => {
    const r = await runDrive(fixture(), [
      "--max-rounds",
      "10",
      "--",
      ...pass(
        "Blocked: finish-round.ts exit 3 (REFUSED_UNCLEAN), the tree is dirty; unblocked by committing it.",
      ),
    ]);
    expectSpawnExit({ ...r, stdout: null }, 14);
    expect(r.stderr).toContain("NOTICE-NAMES-TREE");
    expect(r.stderr).toContain("what the extra round's pass recorded");
    expect(r.stderr).toContain("Blocked: finish-round.ts exit 3");
    expect(r.stderr).not.toContain("Blocked: base-sync.ts exit 3");
  }, 120_000);

  it("records on its stop that it left work in the tree, and only then", async () => {
    const lastStop = async (stateDir: string, cwd: string) => {
      const r = await state(stateDir, ["get", "999"], cwd);
      const events = (JSON.parse(r.stdout) as { events?: unknown[] }).events;
      return (events ?? []).findLast(
        (e) => (e as { kind?: string }).kind === "stop",
      );
    };
    for (const dirty of [true, false]) {
      const repo = makeScratchRepo(`stall-left-work-${String(dirty)}`);
      if (dirty) writeFileSync(join(repo.dir, "left.txt"), "a pass's edit\n");
      const { dir, stateDir } = writeFixture(
        { ...fixture(), head: repo.head, reviewedSha: repo.head },
        repo.dir,
      );
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--max-rounds", "10", "--", ...pass(null)],
        repo.dir,
      );
      expectSpawnExit({ ...r, stdout: null }, 14);
      expect(await lastStop(stateDir, repo.dir)).toMatchObject({
        cause: "14",
        leftWork: dirty,
      });
      expect(await lastStop(stateDir, repo.dir)).toHaveProperty("tree");
    }
  }, 240_000);

  it("says the lines it prints predate the extra round when that pass recorded nothing", async () => {
    const r = await runDrive(fixture(), [
      "--max-rounds",
      "10",
      "--",
      ...pass(null),
    ]);
    expectSpawnExit({ ...r, stdout: null }, 14);
    expect(r.stderr).toContain("the extra round's pass recorded nothing");
    expect(r.stderr).toContain("may no longer hold");
    expect(r.stderr).toContain("Blocked: base-sync.ts exit 3");
  }, 120_000);
});
