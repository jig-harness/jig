/**
 * round-plan.test.ts: the consumer-configured parts of round-plan.ts (the
 * load guard command, the plan command and its `gates.command` fallback) and
 * its refusal on an unconcluded git operation. Every probe runs round-plan.ts
 * as a real subprocess against a scratch repository with its own
 * configuration file, never this checkout's.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { gatesOnlyPlan } from "../scripts/round-plan.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

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
  let bin: string;

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
    out.JIG_OVERLAY = join(dir, ".config", "jig.yaml");
    out.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
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
    writeFileSync(join(dir, ".config", "jig.yaml"), JSON.stringify(overlay));
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
    // A fake `gh` for a branch with no pull request, so the plan diffs
    // against the integration branch; every other call fails.
    bin = mkdtempSync(join(tmpdir(), "round-plan-op-guard-bin-"));
    writeFakeProgram(
      join(bin, "gh"),
      `#!/bin/sh
case "$*" in
  "pr list --head main --state all --json number -q length") echo 0 ;;
  *) echo "gh: no pull request" >&2; exit 1 ;;
esac
`,
    );
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
    rmSync(bin, { recursive: true, force: true });
  });

  it.skipIf(
    skipsOnWindows(
      "git-bash",
      "the overlay-configured validation_plan_command runs through cmd.exe, which mangles its double-quoted executable path",
    ),
  )("resolves a plan on a clean tree", () => {
    const r = roundPlan();
    expect(r.stderr).not.toContain("unconcluded git operation");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("echo stub-check");
  });

  it.skipIf(
    skipsOnWindows(
      "git-bash",
      "the overlay-configured validation_plan_command runs through cmd.exe, which mangles its double-quoted executable path",
    ),
  )("runs the configured load guard before printing the plan", () => {
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

  it.skipIf(
    skipsOnWindows(
      "git-bash",
      "the overlay-configured validation_plan_command runs through cmd.exe, which mangles its double-quoted executable path",
    ),
  )("prints a warning naming a load guard that fails, and still plans", () => {
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
  // test above, which all exercise the probe running successfully and reporting
  // either no marker or a real one. This is the probe itself failing to run at
  // all: a stub `git` on PATH answers `rev-parse --show-toplevel` normally —
  // round-plan.ts's own earlier, unrelated call — but fails `rev-parse
  // --git-dir`, the first call `unconcludedGitOpMarker` itself makes.
  it("fails closed when the git-dir probe itself cannot run", () => {
    const binDir = mkdtempSync(join(tmpdir(), "round-plan-op-guard-bin-"));
    const gitStub = join(binDir, "git");
    writeFakeProgram(
      gitStub,
      `#!/usr/bin/env bash
case "$1 $2" in
  'rev-parse --show-toplevel') echo ${JSON.stringify(dir)} ;;
  'rev-parse --git-dir') echo 'git-stub: simulated probe failure' >&2; exit 1 ;;
  *) echo "git-stub: unexpected call: $*" >&2; exit 1 ;;
esac
`,
    );
    try {
      const r = Bun.spawnSync([process.execPath, ROUND_PLAN], {
        cwd: dir,
        env: { ...env(), PATH: `${binDir}${delimiter}${env().PATH}` },
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

/**
 * A stacked layer diffs against its own pull request's base, the layer
 * below, not the integration branch. The scratch repository holds a
 * two-layer stack on `develop`: `layer-1` adds `lower.txt`, `layer-2` adds
 * `own.txt`, then a base sync merges a later `layer-1` commit (`lower2.txt`)
 * into `layer-2` before the round's own fix. A fake `gh` on PATH answers the
 * pull request's base, how many pull requests the branch has, and the
 * repository `origin` must fetch.
 */
describe("a stacked layer's round base", () => {
  let dir: string;
  let home: string;
  let bin: string;
  let sinceSyncedFix: string;

  function env(
    base: string | null,
    fake: { pulls?: string; repo?: string } = {},
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
        continue;
      out[k] = v;
    }
    out.HOME = home;
    out.GIT_CONFIG_GLOBAL = "/dev/null";
    out.GIT_CONFIG_NOSYSTEM = "1";
    out.JIG_OVERLAY = join(dir, ".config", "jig.yaml");
    out.GIT_AUTHOR_NAME = "round-plan probe";
    out.GIT_AUTHOR_EMAIL = "probe@example.invalid";
    out.GIT_COMMITTER_NAME = "round-plan probe";
    out.GIT_COMMITTER_EMAIL = "probe@example.invalid";
    out.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    out.FAKE_PR_BASE = base ?? "";
    out.FAKE_PR_COUNT = fake.pulls ?? "1";
    out.FAKE_REPO_NAME = fake.repo ?? "widgets";
    return out;
  }

  function mustGit(...args: string[]): string {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: env(null),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`git ${args.join(" ")} → ${r.exitCode}`).toBe(
      `git ${args.join(" ")} → 0`,
    );
    return r.stdout.toString().trim();
  }

  function commitFile(name: string, content: string): void {
    writeFileSync(join(dir, name), content);
    mustGit("add", name);
    mustGit("commit", "-q", "-m", `add ${name}`);
  }

  function roundPlan(
    base: string | null,
    fake: { pulls?: string; repo?: string } = {},
  ): { code: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync([process.execPath, ROUND_PLAN, "--json"], {
      cwd: dir,
      env: env(base, fake),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }

  function plannedFiles(
    base: string | null,
    fake: { pulls?: string; repo?: string } = {},
  ): { files: string[]; stderr: string } {
    const r = roundPlan(base, fake);
    expect(r.code).toBe(0);
    return {
      files: (JSON.parse(r.stdout) as { files: string[] }).files,
      stderr: r.stderr,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "round-plan-stack-"));
    home = mkdtempSync(join(tmpdir(), "round-plan-stack-home-"));
    bin = mkdtempSync(join(tmpdir(), "round-plan-stack-bin-"));
    writeFakeProgram(
      join(bin, "gh"),
      `#!/bin/sh
case "$*" in
  *"--json baseRefName,url")
    [ -n "$FAKE_PR_BASE" ] || { echo 'gh: no pull request' >&2; exit 1; }
    printf '{"baseRefName":"%s","url":"https://github.com/acme/%s/pull/7"}\\n' "$FAKE_PR_BASE" "$FAKE_REPO_NAME" ;;
  "pr list --head layer-2 --state all --json number -q length")
    printf '%s\\n' "$FAKE_PR_COUNT" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
    );
    mustGit("init", "-q", "-b", "develop");
    mustGit("remote", "add", "origin", "https://github.com/acme/widgets.git");
    mkdirSync(join(dir, ".config"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "jig.yaml"),
      JSON.stringify({
        repository: { base_branch: "develop" },
        gates: { command: "make check" },
      }),
    );
    writeFileSync(join(dir, ".git", "info", "exclude"), ".config/\n");
    commitFile("a.txt", "base\n");
    mustGit("update-ref", "refs/remotes/origin/develop", "HEAD");
    mustGit("checkout", "-q", "-b", "layer-1");
    commitFile("lower.txt", "lower\n");
    mustGit("checkout", "-q", "-b", "layer-2");
    commitFile("own.txt", "own\n");
    sinceSyncedFix = mustGit("rev-parse", "HEAD");
    mustGit("checkout", "-q", "layer-1");
    commitFile("lower2.txt", "lower again\n");
    mustGit("update-ref", "refs/remotes/origin/layer-1", "HEAD");
    mustGit("checkout", "-q", "layer-2");
    mustGit("merge", "-q", "--no-edit", "origin/layer-1");
    writeFileSync(join(dir, "own.txt"), "own, fixed\n");
    mustGit("commit", "-q", "-am", "round fix");
  });

  afterEach(() => {
    for (const d of [dir, home, bin])
      rmSync(d, { recursive: true, force: true });
  });

  it("plans only the layer's own files against the pull request's base", () => {
    expect(plannedFiles("layer-1").files).toEqual(["own.txt"]);
  });

  it("diffs against the integration branch, and says so, when the branch has no pull request", () => {
    const r = plannedFiles(null, { pulls: "0" });
    expect(r.files).toEqual(["lower.txt", "lower2.txt", "own.txt"]);
    expect(r.stderr).toContain("no pull request");
  });

  it("diffs the no-pull-request fallback against the remote-tracking ref, not a same-named local branch", () => {
    mustGit("branch", "origin/develop", "HEAD");
    const r = plannedFiles(null, { pulls: "0" });
    expect(r.files).toEqual(["lower.txt", "lower2.txt", "own.txt"]);
    expect(r.stderr).toContain("refs/remotes/origin/develop");
  });

  it("fails closed on a detached HEAD whose pull request cannot be read, rather than assuming it has none", () => {
    mustGit("checkout", "-q", "--detach", "HEAD");
    const r = roundPlan(null, { pulls: "0" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("name the pull request explicitly");
  });

  it("fails closed when the branch's pull request cannot be read", () => {
    const r = roundPlan(null);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read the base branch");
  });

  it("fails closed when the pull request's base is not fetched", () => {
    const r = roundPlan("layer-0");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "git fetch origin +refs/heads/layer-0:refs/remotes/origin/layer-0",
    );
  });

  it("fails closed when origin is not the repository the pull request lives in", () => {
    const r = roundPlan("layer-1", { repo: "widgets-upstream" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("acme/widgets-upstream");
  });

  it("does not count what a base sync brought in from the layer below as the round's own", async () => {
    const saved = { ...process.env };
    try {
      // Drop inherited routing variables (GIT_DIR, GIT_INDEX_FILE, …): the
      // helper runs in this process, so they would point git at the real
      // checkout instead of the scratch stack.
      for (const k of Object.keys(process.env))
        if (k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
          delete process.env[k];
      Object.assign(process.env, env("layer-1"));
      const { changedFilesSinceExcludingMerges } = await import(
        "../scripts/lib/round-delta.ts"
      );
      expect(
        await changedFilesSinceExcludingMerges(dir, "7", sinceSyncedFix),
      ).toEqual(["own.txt"]);
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
