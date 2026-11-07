import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { classifyDrive, type DoctorInput } from "../scripts/lib/doctor.ts";
import { gatherWorktreeLeftovers } from "../scripts/drives.ts";
import {
  scratchClean,
  gitCleanEnv,
  SCRIPTS,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn } from "./drive-loop-harness.ts";
import {
  deadPid,
  plantPrLock,
  progressAt,
  trackedLinkedTree,
} from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

describe("a dead driver's removed or unreadable worktree", () => {
  it("does not diagnose a living process with an old heartbeat and missing tree as DEAD", async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    plantPrLock(
      stateDir,
      process.pid,
      join(tmpRoot, "living-missing-tree"),
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    await progressAt(stateDir, new Date().toISOString());
    const doctor = Bun.spawnSync(
      [process.execPath, join(SCRIPTS, "drives.ts"), "--doctor", "--json"],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_LEDGER: "off",
          DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(doctor, 0);
    const row = JSON.parse(doctor.stdout.toString()).rows.find(
      (row: { key: string }) => row.key === "999",
    );
    expect(row.state).toBe("stale");
    expect(row.doctor.verdict).toBe("UNKNOWN");
  });

  it("admits a missing recorded path and explains recovery from the remote head", async () => {
    const { dir, stateDir } = writeFixture(
      { prState: "MERGED" },
      scratchClean.dir,
    );
    const missing = join(tmpRoot, "removed-tree");
    plantPrLock(stateDir, await deadPid(), missing);
    await progressAt(stateDir, new Date().toISOString());
    const doctor = Bun.spawnSync(
      [process.execPath, join(SCRIPTS, "drives.ts"), "--doctor", "--json"],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_LEDGER: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(doctor, 0);
    expect(
      JSON.parse(doctor.stdout.toString()).rows.find(
        (row: { key: string }) => row.key === "999",
      ).doctor.verdict,
    ).toBe("DEAD");
    const r = await runDriveIn(dir, stateDir, [
      "--take-over",
      "--no-head-sync",
      "--",
      process.execPath,
      "-e",
      "// pass for 999",
    ]);
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain(missing);
    expect(r.stderr).toContain("missing");
    expect(r.stderr).toContain("remote head");
  });

  it.each(["status", "worktree", "malformed"])(
    "refuses an existing registered worktree when git %s fails",
    async (failure) => {
      const { dir, stateDir } = writeFixture(
        { prState: "MERGED" },
        scratchClean.dir,
      );
      const tree = trackedLinkedTree(`failed-${failure}`);
      plantPrLock(stateDir, await deadPid(), tree);
      await progressAt(stateDir, new Date().toISOString());
      const bin = join(dir, "broken-status");
      mkdirSync(bin);
      writeFakeProgram(
        join(bin, "git"),
        `#!/usr/bin/env bun\nif (${JSON.stringify(failure)} === "malformed" && process.argv.includes("worktree")) { process.stdout.write(${JSON.stringify(`worktree ${scratchClean.dir}-other\0HEAD ${"a".repeat(40)}\0\0partial`)}); process.exit(0); }\nif (process.argv.includes(${JSON.stringify(failure)})) process.exit(1);\nconst r = Bun.spawnSync([${JSON.stringify(Bun.which("git"))}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" }); process.exit(r.exitCode);`,
      );
      const r = await runDriveIn(
        dir,
        stateDir,
        [
          "--take-over",
          "--no-head-sync",
          "--",
          process.execPath,
          "-e",
          "// pass for 999",
        ],
        undefined,
        { extraBinDir: bin },
      );
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("could not be inspected");
      expect(r.stderr).toContain("Doctor verdict: UNKNOWN");
    },
  );

  it("distinguishes an unregistered directory from an unreadable clone registry", async () => {
    const orphan = join(tmpRoot, "unregistered-tree");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "left.txt"), "unregistered");
    expect(await gatherWorktreeLeftovers(orphan, scratchClean.dir)).toBeNull();
    expect(await gatherWorktreeLeftovers(orphan, orphan)).toBeNull();
  });

  it("preserves known blockers when a missing tree has a living holder", () => {
    const input: DoctorInput = {
      lockState: "stale",
      processConfirmedGone: false,
      stateReadable: true,
      progressAgeMs: null,
      passChild: false,
      quotaPark: null,
      parkedCount: 1,
      leftovers: "missing",
      stallThresholdMs: 1,
      pr: "999",
      worktreePath: "/removed/tree",
      selfPath: "/drives.ts",
      hostIsLocal: true,
    };
    expect(classifyDrive(input, new Date()).verdict).toBe("NEEDS_HUMAN");
    expect(
      classifyDrive(
        {
          ...input,
          quotaPark: {
            vendor: "codex",
            window: "long",
            at: new Date().toISOString(),
            resetAt: null,
          },
        },
        new Date(),
      ).verdict,
    ).toBe("QUOTA_PARKED");
  });

  it.each([true, false])(
    "does not strand a living holder's edits with stateReadable=%s",
    (stateReadable) => {
      const input: DoctorInput = {
        lockState: "stale",
        processConfirmedGone: false,
        stateReadable,
        progressAgeMs: null,
        passChild: true,
        quotaPark: null,
        parkedCount: 0,
        leftovers: { uncommitted: true, unpushed: false, unconcludedOp: null },
        stallThresholdMs: 1,
        pr: "999",
        worktreePath: "/living/tree",
        selfPath: "/drives.ts",
        hostIsLocal: true,
      };
      expect(classifyDrive(input, new Date()).verdict).toBe("UNKNOWN");
    },
  );

  it("doctor reports missing as DEAD and failed inspection as UNKNOWN", () => {
    const input: DoctorInput = {
      lockState: "stale",
      processConfirmedGone: true,
      stateReadable: true,
      progressAgeMs: null,
      passChild: false,
      quotaPark: null,
      parkedCount: 0,
      leftovers: "missing",
      stallThresholdMs: 1,
      pr: "999",
      worktreePath: "/removed/tree",
      selfPath: "/drives.ts",
      hostIsLocal: true,
    };
    const missing = classifyDrive(input, new Date());
    expect(missing.verdict).toBe("DEAD");
    expect(missing.reason).toContain("missing");
    expect(
      classifyDrive({ ...input, leftovers: null }, new Date()).verdict,
    ).toBe("UNKNOWN");
  });
});
