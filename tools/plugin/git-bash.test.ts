/** Execute shell hook commands under Bash, including Git Bash on Windows. */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../lib/test-helpers/windows-skip.ts";

const root = resolve(import.meta.dir, "../..");

function run(command: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const git = Bun.which("git");
  const gitDir = dirname(git ?? "missing-git");
  const candidates = byPlatform(
    "Windows tests must use Git for Windows Bash, never the WSL bash launcher",
    {
      windows: [
        join(gitDir, "bash.exe"),
        resolve(gitDir, "../bin/bash.exe"),
        resolve(gitDir, "../../bin/bash.exe"),
        join(
          process.env.ProgramFiles ?? "C:/Program Files",
          "Git/bin/bash.exe",
        ),
        join(
          process.env.LOCALAPPDATA ?? "missing-local-app-data",
          "Programs/Git/bin/bash.exe",
        ),
      ],
      posix: [Bun.which("bash") ?? "missing-bash"],
    },
  );
  const bash = candidates.find((candidate) => existsSync(candidate));
  if (!bash)
    throw new Error(
      "Shell command tests require Bash on PATH (Git Bash on Windows)",
    );
  const shellCheck = byPlatform(
    "Git Bash identifies its runtime as MINGW or MSYS; a WSL shell must fail",
    {
      windows:
        'case "$(uname -s)" in MINGW*|MSYS*) ;; *) echo "Expected Git Bash" >&2; exit 2;; esac\n',
      posix: "",
    },
  );
  const child = spawnSync(
    bash,
    ["--noprofile", "--norc", "-c", shellCheck + command, "jig-test"],
    {
      cwd,
      env: { ...process.env, LC_ALL: "C", ...env },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return { ...child, exitCode: child.status };
}

function fakeBun(dir: string): NodeJS.ProcessEnv {
  writeFakeProgram(
    join(dir, "bun"),
    `#!/bin/sh\nprintf '%s\\0' "$@"\nexit "\${JIG_FAKE_EXIT:-0}"\n`,
  );
  return { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
}

test("hook registration expands a plugin root with spaces as one Bun argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-shell-"));
  const hooks = JSON.parse(
    readFileSync(join(root, "plugin/hooks/hooks.json"), "utf8"),
  );
  const command = hooks.hooks.PreToolUse[0].hooks[0].command as string;
  const pluginRoot = join(dir, "plugin cache with spaces").replaceAll(
    "\\",
    "/",
  );
  const result = run(command, dir, {
    ...fakeBun(dir),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  });
  expectSpawnExit(result, 0);
  expect(result.stdout.split("\0").filter(Boolean)).toEqual([
    `${pluginRoot}/hooks/turn-budget-guard.ts`,
  ]);
});

test("push-hold hook skips only an unset variable and propagates a failed recheck", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-shell-"));
  const lefthook = readFileSync(join(root, "lefthook.yml"), "utf8");
  const command = lefthook.match(/run: '(\[ -z.*push-hold-recheck\.ts)'/)?.[1];
  if (!command) throw new Error("push-hold-recheck shell command missing");
  const env = fakeBun(dir);
  const unset = run(`unset DRIVE_PR_HOLD_RECHECK_PR\n${command}`, dir, env);
  expectSpawnExit(unset, 0);
  expect(unset.stdout).toBe("");
  for (const value of ["", "42"]) {
    const armed = run(command, dir, {
      ...env,
      DRIVE_PR_HOLD_RECHECK_PR: value,
      JIG_FAKE_EXIT: "17",
    });
    expectSpawnExit(armed, 17);
    expect(armed.stdout.split("\0").filter(Boolean)).toEqual([
      "plugin/skills/drive-pr/scripts/push-hold-recheck.ts",
    ]);
  }
});
