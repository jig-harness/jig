import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
  ensureCreateHook,
} from "../orca-workspace/hooks.ts";
import { supervisedHook } from "../orca-workspace/supervised-hook.ts";
import { type Context, localContext } from "../orca-workspace/runner.ts";

/** Whether the process is alive, polled until it is not or 5 seconds pass. */
function outlives(pid: number): boolean {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return true;
    Bun.sleepSync(50);
  }
}

/** The process id written to `file`, polled for until 10 seconds pass. */
function pidIn(file: string): number {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    if (Date.now() >= deadline) throw new Error(`no process id in ${file}`);
    Bun.sleepSync(50);
  }
}

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  expectSpawnExit(run, 0, `git ${args.join(" ")}`);
  return run.stdout.toString().trim();
}

/** A clone with a linked worktree whose create hook is `script`. */
function worktreeWithHook(script: string): {
  worktree: string;
  dir: string;
  hook: string;
} {
  const root = mkdtempSync(join(tmpdir(), "jig-orca-hook-"));
  const clone = join(root, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  git(clone, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(root, "wt");
  git(clone, "worktree", "add", "-q", "-b", "feat/x", worktree);
  mkdirSync(join(worktree, ".config", "worktree-hooks"), { recursive: true });
  const hook = join(worktree, ".config", "worktree-hooks", "create");
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
  return {
    worktree,
    dir: git(worktree, "rev-parse", "--absolute-git-dir"),
    hook,
  };
}

const quiet = (): Context => localContext(() => {});

describe("the plugin's local Orca hook runner", () => {
  test("a failed create hook's children are ended before its claim is given back", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "jig-orca-pid-")), "pid");
    const { worktree, dir } = worktreeWithHook(
      `#!/bin/sh\nsleep 300 >/dev/null 2>&1 &\necho $! > ${JSON.stringify(pidFile)}\nexit 4\n`,
    );
    expect(() =>
      ensureCreateHook(
        { host: quiet(), runHook: supervisedHook },
        worktree,
        dir,
      ),
    ).toThrow("failed (exit 4)");
    const child = pidIn(pidFile);
    expect(existsSync(join(dir, CREATE_HOOK_CLAIM))).toBe(false);
    expect(existsSync(join(dir, CREATE_HOOK_MARK))).toBe(false);
    const left = outlives(child);
    if (left) process.kill(child, "SIGKILL");
    expect(left).toBe(false);
  });

  test("records the hook's process group in the claim while it runs", () => {
    const { worktree, dir } = worktreeWithHook(
      `#!/bin/sh\ncat "$(git rev-parse --absolute-git-dir)/${CREATE_HOOK_CLAIM}/hook"\n`,
    );
    const lines: string[] = [];
    expect(
      ensureCreateHook(
        {
          host: localContext((line) => lines.push(line)),
          runHook: supervisedHook,
        },
        worktree,
        dir,
      ),
    ).toBe(true);
    expect(lines.some((line) => /^group \d+/.test(line))).toBe(true);
    expect(existsSync(join(dir, CREATE_HOOK_MARK))).toBe(true);
  });
});
