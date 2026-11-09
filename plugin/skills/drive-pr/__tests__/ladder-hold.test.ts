import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { join } from "node:path";
import { fixtureStateTree } from "./scoped-state-dir.ts";
import { SCRIPTS, gitCleanEnv, useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
const { state, stateDirFor } = createStateDurabilityFixtures(false);
const hold = (key: string, kind = "thread", outcome = "accepted") => [
  "hold",
  "999",
  "--key",
  key,
  "--kind",
  kind,
  "--outcome",
  outcome,
  ...(kind === "thread"
    ? ["--comment-url", "https://example.invalid/reply"]
    : []),
];
const record = (dir: string, key: string, stance = "accepted", round = 0) =>
  state(
    dir,
    ["record-ladder", "999"],
    {},
    JSON.stringify({ key, stance, round }),
  );

describe("accepted hold decline-ladder evidence", () => {
  it("triage-ladder records its measured verdict before a hold", async () => {
    const dir = stateDirFor("ladder-record");
    const proc = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "../../resolve-review-comments/scripts/triage-ladder.ts"),
        "--pr",
        "999",
        "--key",
        "measured",
        "--severity",
        "high",
        "--tier",
        "2",
        "--category",
        "unknown",
        "--self-inflicted",
        "unknown",
      ],
      {
        cwd: fixtureStateTree(dir),
        env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(JSON.parse(stdout).stance).toBe("accepted");
    expectSpawnExit(await state(dir, hold("measured")), 0);
  });
  it("refuses a thread or summary hold without a verdict", async () => {
    for (const kind of ["thread", "finding"]) {
      const dir = stateDirFor(`missing-${kind}`);
      const result = await state(
        dir,
        hold("missing", kind),
        {},
        "accepted reason",
      );
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("no accepted decline-ladder verdict");
      expect((await state(dir, ["held", "999"])).stdout).toBe("[]");
    }
  });
  it("accepts only an accepting verdict for this key and round", async () => {
    const dir = stateDirFor("ladder-scope");
    expectSpawnExit(await record(dir, "other"), 0);
    expectSpawnExit(await state(dir, hold("target")), 2);
    expectSpawnExit(await record(dir, "target", "declined"), 0);
    expectSpawnExit(await state(dir, hold("target")), 2);
    expectSpawnExit(await record(dir, "target"), 0);
    expectSpawnExit(await state(dir, hold("target")), 0);
    expectSpawnExit(
      await state(dir, ["bump-round", "999", "--sha", "a".repeat(40)]),
      0,
    );
    expectSpawnExit(await state(dir, hold("target")), 2);
    expectSpawnExit(await record(dir, "target", "accepted", 0), 2);
    expectSpawnExit(await record(dir, "target", "accepted", 1), 0);
    expectSpawnExit(await state(dir, hold("target")), 0);
  });
  it("does not impose the ladder on moot or unconfirmed crash-recovery holds", async () => {
    const dir = stateDirFor("ladder-recovery");
    expectSpawnExit(await state(dir, hold("moot", "thread", "moot")), 0);
    expectSpawnExit(
      await state(dir, [...hold("recovered"), "--unconfirmed"]),
      0,
    );
    const held: { key: string; round: number }[] = JSON.parse(
      (await state(dir, ["held", "999"])).stdout,
    );
    expect(held).toHaveLength(2);
    expect(held.find((h) => h.key === "recovered")?.round).toBe(-1);
    expectSpawnExit(await state(dir, hold("recovered")), 2);
  });
});
