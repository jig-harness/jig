/**
 * round-plan.test.ts: the consumer-configured parts of round-plan.ts (the
 * load guard command, the plan command and its `gates.command` fallback) and
 * its refusal on an unconcluded git operation. Every probe runs round-plan.ts
 * as a real subprocess against a scratch repository with its own
 * configuration file, never this checkout's.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatesOnlyPlan } from "../scripts/round-plan.ts";

const ROUND_PLAN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "round-plan.ts",
);

describe("gatesOnlyPlan", () => {
  it("is the repository's complete checks as the single local check, with no remote box", () => {
    const plan = gatesOnlyPlan("make check");
    expect(plan.validation.localChecks).toEqual(["make check"]);
    expect(plan.validation.verificationChecks).toEqual([]);
    expect(plan.validation.testbox.required).toBe(false);
  });
});

/**
 * Round-plan.ts refuses on an unconcluded git operation, the same
 * refusal AGENTS.md's resolve snippet makes. Run as a real
 * subprocess against a scratch repository carrying its own stub resolver at
 * `tools/change-areas/resolve.ts`, so the clean case resolves end to end and
 * proves the guard does not refuse a tree it should plan for.
 */
describe("round-plan.ts unconcluded git operation guard", () => {
  let dir: string;
  let home: string;

  // A scrubbed env: an inherited GIT_DIR (a hook, a parent git process) would
  // point every call at the REAL repository, and the developer's global
  // gitconfig (commit.gpgsign, hooksPath) must not reach fixture commits.
  function env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
        continue;
      out[k] = v;
    }
    out.HOME = home;
    out.GIT_CONFIG_GLOBAL = "/dev/null";
    out.GIT_CONFIG_NOSYSTEM = "1";
    out.GROUNDWORK_OVERLAY = join(dir, ".config", "groundwork-overlay.yaml");
    return out;
  }

  function git(...args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        ...env(),
        GIT_AUTHOR_NAME: "round-plan probe",
        GIT_AUTHOR_EMAIL: "probe@example.invalid",
        GIT_COMMITTER_NAME: "round-plan probe",
        GIT_COMMITTER_EMAIL: "probe@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode,
      out: `${r.stdout.toString()}${r.stderr.toString()}`,
    };
  }

  function mustGit(...args: string[]): string {
    const r = git(...args);
    expect(`git ${args.join(" ")} → ${r.code}: ${r.out}`).toStartWith(
      `git ${args.join(" ")} → 0:`,
    );
    return r.out.trim();
  }

  // The scratch repository's own configuration file. Ignored by git through
  // info/exclude below, so it never shows up in the diff being planned.
  function writeOverlay(overlay: Record<string, unknown>): void {
    mkdirSync(join(dir, ".config"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "groundwork-overlay.yaml"),
      JSON.stringify(overlay),
    );
  }

  function roundPlan(): { code: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync([process.execPath, ROUND_PLAN], {
      cwd: dir,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "round-plan-op-guard-"));
    home = mkdtempSync(join(tmpdir(), "round-plan-op-guard-home-"));
    mustGit("init", "-q", "-b", "main");
    // A stub resolver emitting the minimal contract round-plan.ts reads, so
    // the clean case reaches the printed plan without the real catalog.
    writeOverlay({
      repository: { base_branch: "develop" },
      drive: {
        validation_plan_command: `"${process.execPath}" tools/change-areas/resolve.ts`,
      },
    });
    mkdirSync(join(dir, "tools", "change-areas"), { recursive: true });
    writeFileSync(
      join(dir, "tools", "change-areas", "resolve.ts"),
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ validation: { localChecks: ['echo stub-check'], verificationChecks: [], testbox: { required: false } }, reviewSkills: [] }));
`,
    );
    writeFileSync(join(dir, ".git", "info", "exclude"), ".config/\n");
    writeFileSync(join(dir, "a.txt"), "base\n");
    mustGit("add", "-A");
    mustGit("commit", "-q", "-m", "base");
    mustGit("update-ref", "refs/remotes/origin/develop", "HEAD");
    writeFileSync(join(dir, "a.txt"), "branch\n");
    mustGit("commit", "-q", "-am", "branch change");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves a plan on a clean tree", () => {
    const r = roundPlan();
    expect(r.stderr).not.toContain("unconcluded git operation");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("echo stub-check");
  });

  it("runs the configured load guard before printing the plan", () => {
    writeOverlay({
      repository: { base_branch: "develop" },
      drive: {
        validation_plan_command: `"${process.execPath}" tools/change-areas/resolve.ts`,
        load_guard_command: "echo guard-ran >&2",
      },
    });
    const r = roundPlan();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("guard-ran");
    expect(r.stdout).not.toContain("LOAD");
    expect(r.stdout).toContain("echo stub-check");
  });

  it("prints a warning naming a load guard that fails, and still plans", () => {
    writeOverlay({
      repository: { base_branch: "develop" },
      drive: {
        validation_plan_command: `"${process.execPath}" tools/change-areas/resolve.ts`,
        load_guard_command: "exit 3",
      },
    });
    const r = roundPlan();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("the load guard (exit 3) exited 3");
    expect(r.stdout).toContain("echo stub-check");
  });

  it("falls back to gates.command when no plan command is configured", () => {
    writeOverlay({
      repository: { base_branch: "develop" },
      gates: { command: "make check" },
    });
    const r = roundPlan();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("make check");
    expect(r.stdout).not.toContain("echo stub-check");
  });

  it("refuses when neither a plan command nor gates.command is configured", () => {
    writeOverlay({ repository: { base_branch: "develop" } });
    const r = roundPlan();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drive.validation_plan_command");
  });

  it("refuses when the base branch cannot be established", () => {
    writeOverlay({ gates: { command: "make check" } });
    // No origin/HEAD in the scratch clone and no reachable gh repository.
    const r = roundPlan();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("repository.base_branch");
  });

  it("refuses mid-merge, from a real conflicting merge", () => {
    mustGit("checkout", "-q", "-b", "incoming", "origin/develop");
    writeFileSync(join(dir, "a.txt"), "incoming\n");
    mustGit("commit", "-q", "-am", "incoming change");
    mustGit("checkout", "-q", "main");
    // Conflicts by construction, leaving MERGE_HEAD in the git-dir.
    expect(git("merge", "incoming").code).not.toBe(0);
    const r = roundPlan();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "an unconcluded git operation is present (MERGE_HEAD)",
    );
    expect(r.stdout).not.toContain("echo stub-check");
  });

  // The rest are synthesized: the probe reads marker existence, and each is
  // what git leaves behind for its paused operation.
  for (const [marker, kind] of [
    ["CHERRY_PICK_HEAD", "file"],
    ["REVERT_HEAD", "file"],
    ["rebase-merge", "dir"],
    ["rebase-apply", "dir"],
  ] as const) {
    it(`refuses when ${marker} is present`, () => {
      const gitDir = join(dir, ".git");
      if (kind === "dir") mkdirSync(join(gitDir, marker));
      else
        writeFileSync(
          join(gitDir, marker),
          `${mustGit("rev-parse", "HEAD")}\n`,
        );
      const r = roundPlan();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `an unconcluded git operation is present (${marker})`,
      );
      expect(r.stdout).not.toContain("echo stub-check");
    });
  }

  // The claim is "an unreadable probe fails closed" (round-plan.ts's own
  // comment above `unconcludedGitOpMarker`) — a DIFFERENT branch than every
  // test above, which all exercise the probe running successfully and
  // reporting either no marker or a real one. This is the probe itself
  // failing to run at all (review finding, PR #5000 round 8): a stub `git`
  // on PATH answers `rev-parse --show-toplevel` normally — round-plan.ts's
  // own earlier, unrelated call — but fails `rev-parse --git-dir`, the first
  // call `unconcludedGitOpMarker` itself makes.
  it("fails closed when the git-dir probe itself cannot run", () => {
    const binDir = mkdtempSync(join(tmpdir(), "round-plan-op-guard-bin-"));
    const gitStub = join(binDir, "git");
    writeFileSync(
      gitStub,
      `#!/usr/bin/env bash
case "$1 $2" in
  'rev-parse --show-toplevel') echo ${JSON.stringify(dir)} ;;
  'rev-parse --git-dir') echo 'git-stub: simulated probe failure' >&2; exit 1 ;;
  *) echo "git-stub: unexpected call: $*" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(gitStub, 0o755);
    try {
      const r = Bun.spawnSync([process.execPath, ROUND_PLAN], {
        cwd: dir,
        env: { ...env(), PATH: `${binDir}:${env().PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(
        "cannot establish that no git operation is open",
      );
      expect(r.stdout.toString()).not.toContain("echo stub-check");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
