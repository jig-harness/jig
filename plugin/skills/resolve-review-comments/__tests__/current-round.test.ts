/**
 * current-round.test.ts — the round-ordinal read behind the triage rubric's
 * round-4 cutoff.
 *
 * Unit half: what counts as an ordinal. Probe half: the entry script against
 * a throwaway git repo and a throwaway drive database, with GIT_DIR/GIT_WORK_TREE
 * scrubbed from the child env — a leaked GIT_DIR from a hook or parent process
 * would silently point the probe at the REAL repo's git dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRoundOrdinal } from "../scripts/current-round.ts";
import { copySkillScripts } from "./scripts-harness.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "current-round.ts");
const DRIVE_STATE = join(
  import.meta.dir,
  "..",
  "..",
  "drive-pr",
  "scripts",
  "drive-state.ts",
);
describe("isRoundOrdinal", () => {
  it("accepts a counted round", () => {
    expect(isRoundOrdinal("4\n")).toBe(true);
    expect(isRoundOrdinal(`${Number.MAX_SAFE_INTEGER}`)).toBe(true);
  });

  // A bare digit test passes all of these. The first is the dangerous one:
  // parseInt returns Infinity, the script would print the literal `Infinity`,
  // and a `round >= 4` consumer would arm the decline-only cutoff off corrupt
  // state — the exact inversion of the fail-open contract.
  it("refuses junk, a non-canonical form and an unrepresentable ordinal", () => {
    for (const bad of [
      "",
      "   ",
      "4x",
      "-2",
      "0",
      "004",
      "9".repeat(400),
      `${Number.MAX_SAFE_INTEGER + 2}`,
    ])
      expect({ bad, ok: isRoundOrdinal(bad) }).toEqual({ bad, ok: false });
  });
});

describe("current-round.ts probes", () => {
  let repo: string;
  // drive-pr's own round counter is the OTHER loop this script reads. Pointed
  // at a throwaway dir so the probes never see, or touch, a real drive.
  let driveStateDir: string;
  const childEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v !== undefined &&
        !k.toUpperCase().startsWith("GIT_") &&
        !k.toUpperCase().startsWith("DRIVE_PR_")
      ) {
        env[k] = v;
      }
    }
    env.DRIVE_PR_STATE_DIR = driveStateDir;
    // Pinned to THIS test process's own pid, which outlives every
    // `bumpDriveRound` child it spawns — not left to whatever the ambient
    // environment happens to carry. `bumpDriveRound` below calls
    // `drive-state.ts bump-round` for several DIFFERENT PRs (4250, 4251, …)
    // against this ONE shared `repo`, purely for fixture-setup speed — not a
    // claim that one resolver is juggling several PRs at once. Left to
    // inherit ambient `$CLAUDE_PID`, that reads as an IDENTIFIED session
    // locally (a Claude Code harness always sets it) and as ladder tier 3 —
    // sessionless — on a clean CI/gates shell that does not. Tier 3
    // claims a tree-wide presence record keyed by pr, so the
    // SAME shared `repo` reads as "already busy with a different pr" the
    // moment a second PR's bump-round runs — refusing this file's own
    // legitimate multi-PR fixture reuse for a reason that has nothing to do
    // with what these tests actually check (round-counting, not lease
    // semantics). Pinning an explicit session avoids the tier entirely,
    // deterministically, regardless of which shell runs the suite.
    env.DRIVE_PR_SESSION = String(process.pid);
    return env;
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "current-round-"));
    driveStateDir = mkdtempSync(join(tmpdir(), "current-round-drive-"));
    const init = spawnSync("git", ["init", "-q"], {
      cwd: repo,
      env: childEnv(),
      encoding: "utf8",
    });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(driveStateDir, { recursive: true, force: true });
  });

  const runScript = (args: string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: childEnv(),
      encoding: "utf8",
    });

  it("prints 0 when no round has been counted (explicit PR, no network)", () => {
    const r = runScript(["4242"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
  });

  /** `drive-state.ts <args>` against the throwaway database, as a loop calls it. */
  const driveState = (args: string[]) => {
    const r = spawnSync(process.execPath, [DRIVE_STATE, ...args], {
      cwd: repo,
      env: childEnv(),
      encoding: "utf8",
    });
    expectSpawnExit({ ...r, exitCode: r.status }, 0);
    return r.stdout.trim();
  };

  it("prints the review round a hand-driven loop counted, one per distinct head", () => {
    driveState(["count-round", "4243", "--head", "a".repeat(40)]);
    driveState(["count-round", "4243", "--head", "a".repeat(40)]);
    driveState(["count-round", "4243", "--head", "b".repeat(40)]);
    const r = runScript(["4243"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("2");
  });

  it("keeps the ordinal when the loop converges and settles its rounds", () => {
    driveState(["count-round", "4244", "--head", "a".repeat(40)]);
    expect(driveState(["settle-rounds", "4244"])).toBe("1");
    expect(driveState(["open-rounds", "4244"])).toBe("0");
    expect(runScript(["4244"]).stdout.trim()).toBe("1");
    // The next head counts on from there.
    driveState(["count-round", "4244", "--head", "b".repeat(40)]);
    expect(runScript(["4244"]).stdout.trim()).toBe("2");
  });

  it("stays silent on the normal nothing-counted path", () => {
    const r = runScript(["4245"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
    expect(r.stderr).not.toContain("current-round:");
  });

  /**
   * A throwaway skills layout whose `drive-pr/scripts/drive-state.ts` prints
   * exactly `stdout`. Stubbed rather than driven through the real one because
   * the point is what THIS script accepts from that boundary — drive-state's
   * own `isCount` admits any non-negative integer, including one past
   * MAX_SAFE_INTEGER, so it cannot be made to refuse these for us.
   */
  const withStubbedDriveState = (
    stdout: string,
  ): SpawnSyncReturns<string> & { cleanup: () => void } => {
    const fake = mkdtempSync(join(tmpdir(), "current-round-stub-"));
    copySkillScripts(join(fake, "skills"));
    mkdirSync(join(fake, "skills", "drive-pr", "scripts"), { recursive: true });
    writeFileSync(
      join(fake, "skills", "drive-pr", "scripts", "drive-state.ts"),
      `console.log(${JSON.stringify(stdout)});\n`,
    );
    const r = spawnSync(
      process.execPath,
      [
        join(
          fake,
          "skills",
          "resolve-review-comments",
          "scripts",
          "current-round.ts",
        ),
        "4270",
      ],
      { cwd: repo, env: childEnv(), encoding: "utf8" },
    );
    return {
      ...r,
      cleanup: () => rmSync(fake, { recursive: true, force: true }),
    };
  };

  it("refuses a non-canonical ordinal from drive-state.ts, and says so", () => {
    for (const bad of ["9".repeat(400), "9007199254740992", "004", "-1"]) {
      const r = withStubbedDriveState(bad);
      try {
        expect({ bad, out: r.stdout.trim() }).toEqual({ bad, out: "0" });
        expect(r.stderr).toContain("not a canonical ordinal");
      } finally {
        r.cleanup();
      }
    }
  });

  it("stays silent on drive-pr's ordinary 0, and accepts a real count", () => {
    const zero = withStubbedDriveState("0");
    try {
      expect(zero.stdout.trim()).toBe("0");
      expect(zero.stderr).not.toContain("review round count");
    } finally {
      zero.cleanup();
    }
    const six = withStubbedDriveState("6");
    try {
      expect(six.stdout.trim()).toBe("6");
    } finally {
      six.cleanup();
    }
  });

  // The sibling skill is an optional dependency, and its absence is ordinary
  // — so it must be established before the spawn. The executable is the
  // runtime, which always exists, so a missing entrypoint is just bun exiting
  // 1: indistinguishable from a script that ran and failed, which made the
  // anomaly line print on every read for a standalone install.
  it("stays silent when the sibling drive-pr skill is not installed", () => {
    const solo = mkdtempSync(join(tmpdir(), "current-round-solo-"));
    try {
      // A copy of the skill with no ../../drive-pr beside it.
      const scripts = copySkillScripts(join(solo, "skills"));
      const r = spawnSync(
        process.execPath,
        [join(scripts, "current-round.ts"), "4260"],
        { cwd: repo, env: childEnv(), encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("0");
      expect(r.stderr).not.toContain("review round count");
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  it("exits 2 on a flag or extra arguments", () => {
    expect(runScript(["--help"]).status).toBe(2);
    expect(runScript(["1", "2"]).status).toBe(2);
  });
});
