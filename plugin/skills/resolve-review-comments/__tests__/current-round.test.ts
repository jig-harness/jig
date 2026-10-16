/**
 * current-round.test.ts — the round-ordinal read behind the triage rubric's
 * round-4 cutoff (TASK).
 *
 * Unit half: the counter-file parse. Probe half: the entry script against a
 * throwaway git repo, with GIT_DIR/GIT_WORK_TREE scrubbed from the child env —
 * a leaked GIT_DIR from a hook or parent process would silently point the
 * probe (or worse, a future write) at the REAL repo's git dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoundCount } from "../scripts/current-round.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "current-round.ts");
describe("parseRoundCount", () => {
  it("parses a counted round", () => {
    expect(parseRoundCount("4\n")).toBe(4);
  });

  it("reads an absent file as 0", () => {
    expect(parseRoundCount(null)).toBe(0);
  });

  it("reads junk and empty as 0, never a crash", () => {
    expect(parseRoundCount("")).toBe(0);
    expect(parseRoundCount("   ")).toBe(0);
    expect(parseRoundCount("4x\n")).toBe(0);
    expect(parseRoundCount("-2")).toBe(0);
  });

  // A bare digit test passes all of these. The first is the dangerous one:
  // parseInt returns Infinity, the script printed the literal `Infinity`, and
  // a `round >= 4` consumer armed the decline-only cutoff off corrupt state —
  // the exact inversion of the fail-open contract.
  it("refuses a non-canonical or unrepresentable ordinal", () => {
    expect(parseRoundCount("9".repeat(400))).toBe(0);
    expect(parseRoundCount(`${Number.MAX_SAFE_INTEGER + 2}`)).toBe(0);
    expect(parseRoundCount("0")).toBe(0);
    expect(parseRoundCount("004")).toBe(0);
    // …while the forms the producer actually writes still parse.
    expect(parseRoundCount("1\n")).toBe(1);
    expect(parseRoundCount(`${Number.MAX_SAFE_INTEGER}`)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
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
    // sessionless — on a clean CI/gates shell that does not. Tier 3 now
    // claims a tree-wide presence record keyed by pr (TASK), so the
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

  it("prints the counted ordinal from the git-dir counter", () => {
    writeFileSync(join(repo, ".git", "resolve-review-rounds-4242"), "5\n");
    const r = runScript(["4242"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("5");
  });

  // Fails OPEN on the value — arming a decline-only rule on state that could
  // not be established is the direction that loses findings — but never
  // SILENTLY: an absent counter is normal, a corrupt one is not, and stdout
  // alone cannot tell them apart.
  it("reads a corrupt counter as 0 rather than failing the triage, and says so", () => {
    writeFileSync(join(repo, ".git", "resolve-review-rounds-4243"), "oops\n");
    const r = runScript(["4243"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
    expect(r.stderr).toContain("holds no round ordinal");
  });

  it("reads an unreadable counter as 0, and says so", () => {
    // A directory where the file belongs: an errno that is deterministically
    // not ENOENT on every platform, without depending on a chmod the test
    // user (root in a container) may be able to ignore.
    mkdirSync(join(repo, ".git", "resolve-review-rounds-4244"));
    const r = runScript(["4244"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
    expect(r.stderr).toContain("is unreadable");
  });

  it("stays silent on the normal absent-counter path", () => {
    const r = runScript(["4245"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0");
    expect(r.stderr).not.toContain("current-round: counter");
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
    cpSync(
      join(import.meta.dir, "..", "scripts"),
      join(fake, "resolve-review-comments", "scripts"),
      { recursive: true },
    );
    mkdirSync(join(fake, "drive-pr", "scripts"), { recursive: true });
    writeFileSync(
      join(fake, "drive-pr", "scripts", "drive-state.ts"),
      `console.log(${JSON.stringify(stdout)});\n`,
    );
    const r = spawnSync(
      process.execPath,
      [
        join(fake, "resolve-review-comments", "scripts", "current-round.ts"),
        "4270",
      ],
      { cwd: repo, env: childEnv(), encoding: "utf8" },
    );
    return {
      ...r,
      cleanup: () => rmSync(fake, { recursive: true, force: true }),
    };
  };

  it("takes the higher ordinal across the local counter and sibling CLI boundary", () => {
    const counter = join(repo, ".git", "resolve-review-rounds-4270");
    for (const [local, sibling, expected] of [
      [7, 1, 7],
      [1, 3, 3],
    ]) {
      writeFileSync(counter, `${local}\n`);
      const r = withStubbedDriveState(String(sibling));
      try {
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(String(expected));
      } finally {
        r.cleanup();
        rmSync(counter, { force: true });
      }
    }
  });

  // The round-3 fix tightened the counter FILE's parse and left this sibling
  // input on a bare digit test — the same defect, one path over.
  it("refuses a non-canonical ordinal from drive-pr too, and says so", () => {
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
      expect(zero.stderr).not.toContain("drive-pr round count");
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
      // A copy of scripts/ with no ../../drive-pr beside it.
      cpSync(join(import.meta.dir, "..", "scripts"), join(solo, "scripts"), {
        recursive: true,
      });
      const r = spawnSync(
        process.execPath,
        [join(solo, "scripts", "current-round.ts"), "4260"],
        { cwd: repo, env: childEnv(), encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("0");
      expect(r.stderr).not.toContain("drive-pr round count");
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  it("exits 2 on a flag or extra arguments", () => {
    expect(runScript(["--help"]).status).toBe(2);
    expect(runScript(["1", "2"]).status).toBe(2);
  });
});
