import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  SCRIPTS,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

useDrivePrSuite();

describe("repository-scoped drive history", () => {
  it("starts the same PR fresh in another repository and labels both listings", async () => {
    const first = makeScratchRepo("scope-first");
    const second = makeScratchRepo("scope-second");
    const fixtureA = writeFixture(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      first.dir,
    );
    const fixtureB = writeFixture(
      { threads: [{ id: "PRRT_b", path: "b.ts", bot: true }] },
      second.dir,
    );
    const root = dirname(fixtureA.stateDir);
    const dirA = scopedStateDir(root, first.dir);
    const dirB = scopedStateDir(root, second.dir);
    const args = ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_NOOP];
    const a = await runDriveIn(fixtureA.dir, root, args, first.dir);
    expectSpawnExit({ ...a, stdout: null }, 6);
    const saved = JSON.parse(
      readFileSync(join(dirA, "drive-pr-999.json"), "utf8"),
    );
    saved.parked = [
      { key: "only-first", kind: "thread", reason: "Human decision", round: 1 },
    ];
    const savedA = JSON.stringify(saved);
    writeFileSync(join(dirA, "drive-pr-999.json"), savedA);
    const handoffA = readFileSync(
      join(fixtureA.dir, "handoff", "pr-drive-999.md"),
      "utf8",
    );
    const b = await runDriveIn(fixtureB.dir, root, args, second.dir);
    expectSpawnExit({ ...b, stdout: null }, 6);
    expect(b.stderr).toContain("round 1");
    expect(
      JSON.parse(readFileSync(join(dirB, "drive-pr-999.json"), "utf8")).rounds,
    ).toBe(1);
    expect(readFileSync(join(dirA, "drive-pr-999.json"), "utf8")).toBe(savedA);
    expect(readFileSync(join(dirA, "drive-pr-999.log"), "utf8")).toContain(
      dirA,
    );
    expect(readFileSync(join(dirB, "drive-pr-999.log"), "utf8")).toContain(
      dirB,
    );
    expect(
      JSON.parse(readFileSync(join(dirB, "drive-pr-999.json"), "utf8")).parked,
    ).toEqual([]);
    expect(
      readFileSync(join(fixtureB.dir, "handoff", "pr-drive-999.md"), "utf8"),
    ).not.toContain("only-first");
    expect(
      readFileSync(join(fixtureA.dir, "handoff", "pr-drive-999.md"), "utf8"),
    ).toBe(handoffA);
    expect(dirA).not.toBe(dirB);
    for (const [repo, leaf] of [
      [first, dirA],
      [second, dirB],
    ] as const) {
      // A released driver leaves no lock; retain an empty operator slot for
      // both the plain lock census and doctor's census.
      mkdirSync(join(leaf, "pr-drive-999.lock"), { recursive: true });
      const env = {
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: root,
        DRIVE_PR_WORKTREE: repo.dir,
      };
      const local = Bun.spawnSync(
        [process.execPath, join(SCRIPTS, "drives.ts"), "--json"],
        {
          cwd: repo === first ? second.dir : first.dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(local, 0);
      expect(JSON.parse(local.stdout.toString()).rows[0].repository).toBe(
        join(repo.dir, ".git"),
      );
      const remote = `sample/${repo === first ? "first" : "second"}`;
      expectSpawnExit(
        Bun.spawnSync(
          [
            "git",
            "remote",
            "add",
            "origin",
            `https://user:secret@example.invalid/${remote}.git`,
          ],
          { cwd: repo.dir, env: gitCleanEnv() },
        ),
        0,
      );
      const json = Bun.spawnSync(
        [process.execPath, join(SCRIPTS, "drives.ts"), "--doctor", "--json"],
        { cwd: repo.dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(json, 0);
      const listing = JSON.parse(json.stdout.toString());
      expect(listing.stateDir).toBe(leaf);
      expect(listing.rows.length).toBeGreaterThan(0);
      expect(
        listing.rows.every(
          (row: { repository: string }) => row.repository === remote,
        ),
      ).toBe(true);
      const human = Bun.spawnSync(
        [process.execPath, join(SCRIPTS, "drives.ts"), "--doctor"],
        { cwd: repo.dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(human, 0);
      expect(human.stdout.toString()).toContain(`repository: ${remote}`);
      const plain = Bun.spawnSync(
        [process.execPath, join(SCRIPTS, "drives.ts")],
        { cwd: repo.dir, env, stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(plain, 0);
      expect(plain.stdout.toString()).toContain(`repository: ${remote}`);
      expect(json.stdout.toString()).not.toContain("secret");
    }
  }, 120_000);

  it("refuses flat legacy artifacts without adopting another repository's history", async () => {
    const repo = makeScratchRepo("scope-legacy");
    const fixture = writeFixture({}, repo.dir);
    const root = dirname(fixture.stateDir);
    mkdirSync(root, { recursive: true });
    const path = join(root, "drive-pr-999.json");
    const text = '{"repository":"sample/old","rounds":9}\n';
    writeFileSync(path, text);
    const result = await runDriveIn(
      fixture.dir,
      root,
      ["--", ...PASS_NOOP],
      repo.dir,
    );
    expectSpawnExit({ ...result, stdout: null }, 2);
    expect(result.stderr).toContain("unscoped state artifact");
    expect(result.stderr).toContain("Current clone:");
    expect(result.stderr).toContain("legacy repository: unknown");
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
