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
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
  ensureCreateHook,
} from "../orca-workspace/hooks.ts";
import { supervisedHook } from "../orca-workspace/supervised-hook.ts";
import {
  type Context,
  localContext,
  UnendedGroupError,
} from "../orca-workspace/runner.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

const quiet = (): Context => localContext(() => undefined);

describe.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "the hook is a shell script and its children are ended through POSIX process groups",
  ),
)("the plugin's local Orca hook runner", () => {
  test("a failed create hook's children are ended before its claim is given back", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "jig-orca-pid-")), "pid");
    const { worktree, dir } = worktreeWithHook(
      `#!/bin/sh\nsleep 300 >/dev/null 2>&1 &\necho $! > ${JSON.stringify(pidFile)}\nexit 4\n`,
    );
    const seen: { aliveAtRelease?: boolean } = {};
    expect(() =>
      ensureCreateHook(
        {
          host: quiet(),
          // The runner returning is the last moment before the claim is given back.
          runHook: (ctx, wt, hook, groupFile) => {
            try {
              supervisedHook(ctx, wt, hook, groupFile);
            } finally {
              seen.aliveAtRelease = alive(pidIn(pidFile));
            }
          },
        },
        worktree,
        dir,
      ),
    ).toThrow("failed (exit 4)");
    const child = pidIn(pidFile);
    if (alive(child)) process.kill(child, "SIGKILL");
    expect(seen.aliveAtRelease).toBe(false);
    expect(existsSync(join(dir, CREATE_HOOK_CLAIM))).toBe(false);
    expect(existsSync(join(dir, CREATE_HOOK_MARK))).toBe(false);
  });

  test("records the hook's process group in the claim while it runs", () => {
    const { worktree, dir } = worktreeWithHook(
      // The supervisor records the group just after the hook starts, so the
      // hook waits for that line, for up to 10 seconds, before printing it.
      [
        "#!/bin/sh",
        `record="$(git rev-parse --absolute-git-dir)/${CREATE_HOOK_CLAIM}/hook"`,
        "i=0",
        `while ! grep -q '^group ' "$record" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done`,
        'cat "$record"',
        "",
      ].join("\n"),
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

  /** A hook that fails with exit 4 after replacing its own group record with a directory, so ending its group cannot read it. */
  const failsWithUnreadableRecord = (record: string) =>
    [
      "#!/bin/sh",
      `record=${record}`,
      "i=0",
      `while ! grep -q '^group ' "$record" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done`,
      'rm -f "$record"',
      'mkdir "$record"',
      "exit 4",
      "",
    ].join("\n");
  const claimRecord = `"$(git rev-parse --absolute-git-dir)/${CREATE_HOOK_CLAIM}/hook"`;

  test("a group that cannot be ended keeps the hook's own failure first", () => {
    const record = join(mkdtempSync(join(tmpdir(), "jig-orca-rec-")), "hook");
    const { worktree, hook } = worktreeWithHook(
      failsWithUnreadableRecord(JSON.stringify(record)),
    );
    // The hook has its own failure (exit 4) and then the cleanup fails.
    const failure = (() => {
      try {
        supervisedHook(quiet(), worktree, hook, record);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(UnendedGroupError);
    expect((failure as Error).message).toMatch(
      /^\S+create failed \(exit 4\); its process group may still be running/,
    );
  });

  test("a claim whose group cannot be ended stays", () => {
    const { worktree, dir } = worktreeWithHook(
      failsWithUnreadableRecord(claimRecord),
    );
    expect(() =>
      ensureCreateHook(
        { host: quiet(), runHook: supervisedHook },
        worktree,
        dir,
      ),
    ).toThrow(/remove .* then open the workspace again/);
    expect(existsSync(join(dir, CREATE_HOOK_CLAIM))).toBe(true);
    expect(existsSync(join(dir, CREATE_HOOK_MARK))).toBe(false);
  });
});
