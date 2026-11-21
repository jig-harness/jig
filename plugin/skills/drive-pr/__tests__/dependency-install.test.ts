import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

const script = join(import.meta.dir, "../scripts/dependency-install.ts");
const installCommand = "bun install-fixture.ts";
const tempRoots: string[] = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(GIT_|JIG_|DRIVE_PR_)/.test(key),
  ),
);

afterEach(() => {
  for (const dir of tempRoots.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

function git(cwd: string, args: string[], code = 0): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, code);
  return result.stdout.toString().trim();
}

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "jig-dependency-install-"));
  tempRoots.push(cwd);
  git(cwd, ["init", "-b", "topic"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(cwd, ".config"));
  writeFileSync(
    join(cwd, ".config/jig.yaml"),
    `drive:
  dependency_install:
    bun.lock: ${installCommand}
`,
  );
  writeFileSync(
    join(cwd, "install-fixture.ts"),
    `import { copyFileSync } from "node:fs";
copyFileSync("bun.lock", "installed-version");
`,
  );
  writeFileSync(join(cwd, "bun.lock"), "old");
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "example.txt"), "initial");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "initial"]);
  return cwd;
}

function baseChange(cwd: string, name: string, contents: string): string {
  const before = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["switch", "-qc", "base"]);
  writeFileSync(join(cwd, name), contents);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "base updated"]);
  git(cwd, ["switch", "-q", "topic"]);
  return before;
}

function refresh(cwd: string, args: string[], code = 0, extraEnv = {}) {
  const result = Bun.spawnSync(scriptArgv(script, ...args), {
    cwd,
    env: { ...env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, code);
  return JSON.parse(result.stdout.toString());
}

describe("dependency refresh before merge validation", () => {
  it("installs the merged lockfile before a validation command reads it", () => {
    const cwd = fixture();
    const before = baseChange(cwd, "bun.lock", "new");
    git(cwd, ["merge", "-q", "--no-ff", "base"]);
    expect(refresh(cwd, ["--before", before])).toEqual({
      outcome: "installed",
      installs: [{ command: installCommand, cwd: ".", exitCode: 0 }],
    });
    const validation = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `if (await Bun.file("installed-version").text() !== "new") process.exit(1)`,
      ],
      {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(validation, 0);
  });

  it("finds a manifest-only change in the resolved merge index", () => {
    const cwd = fixture();
    baseChange(cwd, "package.json", '{"dependencies":{}}');
    git(cwd, ["merge", "-q", "--no-commit", "--no-ff", "base"]);
    expect(refresh(cwd, []).outcome).toBe("installed");
    expect(existsSync(join(cwd, "installed-version"))).toBe(true);
    git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]);
  });

  it("finds a lockfile merged without conflict when another file conflicted", () => {
    const cwd = fixture();
    baseChange(cwd, "bun.lock", "new");
    git(cwd, ["switch", "-q", "base"]);
    writeFileSync(join(cwd, "example.txt"), "base");
    git(cwd, ["commit", "-qam", "base conflict side"]);
    git(cwd, ["switch", "-q", "topic"]);
    writeFileSync(join(cwd, "example.txt"), "topic");
    git(cwd, ["commit", "-qam", "topic conflict side"]);
    git(cwd, ["merge", "--no-edit", "base"], 1);
    expect(refresh(cwd, [], 2).reason).toContain("still has conflicts");
    git(cwd, ["add", "example.txt"]);
    expect(refresh(cwd, []).outcome).toBe("installed");
    expect(existsSync(join(cwd, "installed-version"))).toBe(true);
  });

  it("skips a clean merge whose dependency inputs did not change", () => {
    const cwd = fixture();
    const before = baseChange(cwd, "example.txt", "updated");
    git(cwd, ["merge", "-q", "--no-ff", "base"]);
    expect(refresh(cwd, ["--before", before])).toEqual({
      outcome: "skipped",
      installs: [],
    });
    expect(existsSync(join(cwd, "installed-version"))).toBe(false);
  });

  it("labels a failed install and keeps its command and exit code", () => {
    const cwd = fixture();
    const before = baseChange(cwd, "bun.lock", "new");
    git(cwd, ["merge", "-q", "--no-ff", "base"]);
    writeFileSync(join(cwd, "install-fixture.ts"), "process.exit(17);");
    const report = refresh(cwd, ["--before", before], 1);
    expect(report.outcome).toBe("failed");
    expect(report.installs).toEqual([
      { command: installCommand, cwd: ".", exitCode: 17 },
    ]);
    expect(report.reason).toContain("install failed");
  });

  it("uses the driver's worktree and reviewed install override", () => {
    const cwd = fixture();
    const before = baseChange(cwd, "bun.lock", "new");
    git(cwd, ["merge", "-q", "--no-ff", "base"]);
    writeFileSync(
      join(cwd, ".config/jig.yaml"),
      "drive:\n  dependency_install:\n    bun.lock: false\n",
    );
    const report = refresh(fixture(), ["--before", "HEAD^1"], 0, {
      DRIVE_PR_TARGET: "99",
      DRIVE_PR_WORKTREE: cwd,
      DRIVE_PR_POLICY_BASE: before,
    });
    expect(report.outcome).toBe("installed");
    expect(report.installs).toEqual([
      { command: installCommand, cwd: ".", exitCode: 0 },
    ]);
  });

  it("refuses an installer that stages a lockfile rewrite", () => {
    const cwd = fixture();
    const before = baseChange(cwd, "bun.lock", "new");
    git(cwd, ["merge", "-q", "--no-ff", "base"]);
    writeFileSync(
      join(cwd, "install-fixture.ts"),
      `await Bun.write("bun.lock", "rewritten");
const result = Bun.spawnSync(["git", "add", "bun.lock"]);
process.exit(result.exitCode);`,
    );
    const report = refresh(cwd, ["--before", before], 1);
    expect(report.reason).toContain("failed to preserve the merge tree");
    expect(report.reason).toContain("bun.lock");
  });
});
