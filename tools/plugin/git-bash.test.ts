/** Execute the shipped shell commands under Bash, including Git Bash on Windows. */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../lib/test-helpers/windows-skip.ts";

const root = resolve(import.meta.dir, "../..");
const review = readFileSync(
  join(root, "plugin/skills/review/SKILL.md"),
  "utf8",
);

function run(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
) {
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
    ["--noprofile", "--norc", "-c", shellCheck + command, "jig-test", ...args],
    {
      cwd,
      env: { ...process.env, LC_ALL: "C", ...env },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return { ...child, exitCode: child.status };
}

function snippet(pattern: RegExp): string {
  const command = review.match(pattern)?.[0];
  if (!command) throw new Error(`Review shell command missing: ${pattern}`);
  return command.replaceAll("<effective-files>", "effective-files");
}

test("review deduplicates NUL paths and filters deleted files without splitting names", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-shell-"));
  const names = [
    "with space.ts",
    "quote'and[glob].ts",
    "unicode-é.ts",
  ] as const;
  for (const name of names) writeFileSync(join(dir, name), "present");
  const collect = snippet(
    /printf '%s\\0' "\$@" \| sort -zu > "<effective-files>"/,
  );
  const filter = snippet(
    /while IFS= read -r -d '' f; do if \[ -f "\$f" \]; then printf '%s\\0' "\$f"; fi; done < "<effective-files>"/,
  );
  const result = run(`set -eo pipefail\n${collect}\n${filter}`, dir, {}, [
    ...names,
    names[0],
    "zz-deleted.ts",
  ]);
  expectSpawnExit(result, 0);
  expect(result.stdout.split("\0").filter(Boolean).sort()).toEqual(
    [...names].sort(),
  );
  const onlyDeleted = run(`set -eo pipefail\n${collect}\n${filter}`, dir, {}, [
    "deleted.ts",
  ]);
  expectSpawnExit(onlyDeleted, 0);
  expect(onlyDeleted.stdout).toBe("");
});

test("review catalog membership is a literal whole NUL record", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-catalog-shell-"));
  const catalog = "catalog[1].yaml";
  const membership = snippet(
    /grep -qzxF "<catalog>" "<effective-files>" && echo "catalog_changed"/,
  ).replaceAll("<catalog>", catalog);
  writeFileSync(
    join(dir, "effective-files"),
    `prefix/${catalog}\0catalog1.yaml\0${catalog}.bak\0`,
  );
  const absent = run(membership, dir);
  expectSpawnExit(absent, 1);
  expect(absent.stdout).toBe("");
  writeFileSync(join(dir, "effective-files"), `${catalog}\0`);
  const present = run(membership, dir);
  expectSpawnExit(present, 0);
  expect(present.stdout).toBe("catalog_changed\n");
});

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
