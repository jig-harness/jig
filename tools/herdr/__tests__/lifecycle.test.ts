import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import {
  awaitCreateHook,
  createdWorktreePath,
  HOOKS_DIR,
  hookPath,
  runCreateHook,
  runHook,
} from "../lifecycle.ts";
import { type Context, localContext } from "../runner.ts";

const TOOL = join(import.meta.dir, "..", "workspace.ts");

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(
    [
      "git",
      "-C",
      cwd,
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      ...args,
    ],
    {
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    },
  );
  if (run.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** A clone with a linked worktree on `feat/y`, and hooks that record where they ran. */
function fixture(hooks: { create?: string; remove?: string }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-hooks-")));
  const clone = join(root, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  mkdirSync(join(clone, HOOKS_DIR), { recursive: true });
  for (const [name, body] of Object.entries(hooks))
    writeFileSync(join(clone, HOOKS_DIR, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(root, "wt");
  git(clone, "worktree", "add", "-q", "-b", "feat/y", worktree);
  return { root, clone, worktree };
}

/** The worktree's git directory, read without a caller's `GIT_DIR`. */
function gitDirOf(worktree: string): string {
  const revParse = Bun.spawnSync(
    ["git", "-C", worktree, "rev-parse", "--absolute-git-dir"],
    { env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
  );
  expectSpawnExit(revParse, 0, "git rev-parse --absolute-git-dir");
  return revParse.stdout.toString().trim();
}

const quiet = (): Context & { lines: string[] } => {
  const lines: string[] = [];
  return { ...localContext((line) => lines.push(line)), lines };
};

describe("the create hook", () => {
  test("runs once, whoever asks first", () => {
    const { worktree } = fixture({ create: 'echo ran >> "$PWD/.hook-runs"' });
    const ctx = quiet();
    runCreateHook(ctx, worktree);
    runCreateHook(ctx, worktree);
    awaitCreateHook(ctx, worktree, 0);
    expect(readFileSync(join(worktree, ".hook-runs"), "utf8")).toBe("ran\n");
  });

  test("runs here when no plugin took it", () => {
    const { worktree } = fixture({ create: 'echo ran >> "$PWD/.hook-runs"' });
    awaitCreateHook(quiet(), worktree, 0);
    expect(readFileSync(join(worktree, ".hook-runs"), "utf8")).toBe("ran\n");
  });

  test("a failure is thrown and runs again next time", () => {
    const { worktree } = fixture({
      create: 'echo ran >> "$PWD/.hook-runs"; exit 3',
    });
    expect(() => awaitCreateHook(quiet(), worktree, 0)).toThrow(
      "failed (exit 3)",
    );
    expect(() => awaitCreateHook(quiet(), worktree, 0)).toThrow(
      "failed (exit 3)",
    );
    expect(readFileSync(join(worktree, ".hook-runs"), "utf8")).toBe(
      "ran\nran\n",
    );
  });

  test("a claim whose owner ended without a result is taken over and the hook run", () => {
    const { worktree } = fixture({ create: 'echo ran >> "$PWD/.hook-runs"' });
    const gitDir = gitDirOf(worktree);
    const claim = join(gitDir, "jig", "worktree-create.claim");
    mkdirSync(claim, { recursive: true });
    // A process id above every system's maximum is never running.
    writeFileSync(join(claim, "owner"), `${hostname()} 99999999\n`);
    const ctx = quiet();
    awaitCreateHook(ctx, worktree, 0);
    expect(readFileSync(join(worktree, ".hook-runs"), "utf8")).toBe("ran\n");
    expect(ctx.lines.join("\n")).toContain("ended without a result");
  });

  test("a claim whose owner ended while its hook still runs is not taken over", () => {
    const { worktree } = fixture({ create: 'echo ran >> "$PWD/.hook-runs"' });
    const claim = join(gitDirOf(worktree), "jig", "worktree-create.claim");
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "owner"), `${hostname()} 99999999\n`);
    // The earlier run's hook, still in its own process group.
    const hook = Bun.spawn(["sleep", "30"], { detached: true });
    try {
      writeFileSync(join(claim, "hook"), `group ${hook.pid}\n`);
      let polls = 0;
      const ctx = {
        ...quiet(),
        sleep: () => {
          polls++;
          // The earlier run finishes after a few polls.
          if (polls === 5)
            writeFileSync(
              join(gitDirOf(worktree), "jig", "worktree-create.result"),
              "ok\n",
            );
        },
      };
      awaitCreateHook(ctx, worktree, 0);
      expect(polls).toBe(5);
      expect(existsSync(join(worktree, ".hook-runs"))).toBe(false);
    } finally {
      hook.kill("SIGKILL");
    }
  });

  test("a failed hook's children are ended before it can run again", () => {
    const { worktree } = fixture({
      create: 'sleep 30 >/dev/null 2>&1 & echo $! > "$PWD/.child"; exit 3',
    });
    expect(() => awaitCreateHook(quiet(), worktree, 0)).toThrow(
      "failed (exit 3)",
    );
    const child = Number(readFileSync(join(worktree, ".child"), "utf8"));
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(child, 0);
        Bun.sleepSync(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("a hook that cannot be started says so", () => {
    const { worktree } = fixture({});
    const hook = join(worktree, "broken-hook");
    writeFileSync(hook, "#!/nonexistent/interpreter\n", { mode: 0o755 });
    expect(() => runHook(quiet(), worktree, hook)).toThrow("did not complete");
  });

  test("a hook that is not executable is an error, a missing one nothing", () => {
    const { worktree } = fixture({});
    expect(hookPath(worktree, "create")).toBeNull();
    mkdirSync(join(worktree, HOOKS_DIR), { recursive: true });
    writeFileSync(join(worktree, HOOKS_DIR, "create"), "#!/bin/sh\n", {
      mode: 0o644,
    });
    expect(() => hookPath(worktree, "create")).toThrow("not executable");
  });
});

test("the event's worktree path is read from Herdr's event", () => {
  expect(
    createdWorktreePath(
      JSON.stringify({
        event: "worktree_created",
        data: { worktree: { path: "/wt" } },
      }),
    ),
  ).toBe("/wt");
  expect(() => createdWorktreePath(undefined)).toThrow("not set");
  expect(() => createdWorktreePath("{}")).toThrow("names no worktree path");
});

/** A fake `herdr` that logs each call and answers like Herdr does. */
function fakeHerdr(
  root: string,
  worktrees: unknown[] = [],
): { bin: string; log: string } {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "herdr.log");
  writeFakeProgram(
    join(bin, "herdr"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "worktree list") echo '${JSON.stringify({ result: { worktrees } })}' ;;
  "worktree open") echo '{"result":{"workspace":{"workspace_id":"w9"}}}' ;;
  "worktree remove") echo '{"result":{}}' ;;
  *) echo '{"error":{"code":"unexpected","message":"unexpected"}}' >&2; exit 1 ;;
esac
`,
  );
  return { bin, log };
}

function runTool(
  root: string,
  bin: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  return Bun.spawnSync([process.execPath, TOOL, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      JIG_HOME: join(root, ".jig"),
      JIG_USER_LAYER: "off",
      JIG_OVERLAY: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("remove", () => {
  test("runs the remove hook in the worktree, parks, then removes", () => {
    const { root, clone, worktree } = fixture({
      remove: 'pwd > "$HOME/remove-ran-in"',
    });
    const { bin, log } = fakeHerdr(root);
    const run = runTool(root, bin, [
      "remove",
      "--repo",
      clone,
      "--branch",
      "feat/y",
    ]);
    expectSpawnExit(run, 0, "remove");
    expect(readFileSync(join(root, "remove-ran-in"), "utf8").trim()).toBe(
      worktree,
    );
    expect(run.stdout.toString()).toContain('"parked":0');
    expect(readFileSync(log, "utf8")).toContain(
      "worktree remove --workspace w9",
    );
  });

  test("parks the worktree's own findings, whatever the caller's environment names", () => {
    const { root, clone, worktree } = fixture({});
    mkdirSync(join(worktree, ".config"), { recursive: true });
    writeFileSync(
      join(worktree, ".config", "jig.yaml"),
      "reflection:\n  enabled: true\n",
    );
    const env = {
      ...process.env,
      HOME: root,
      JIG_HOME: join(root, ".jig"),
      JIG_USER_LAYER: "off",
      JIG_OVERLAY: undefined,
    };
    const noted = Bun.spawnSync(
      [
        process.execPath,
        join(
          import.meta.dir,
          "../../../plugin/skills/reflect/scripts/journal.ts",
        ),
        "note",
      ],
      {
        cwd: worktree,
        env,
        stdin: new Blob([
          JSON.stringify({
            kind: "error",
            severity: "low",
            class: "instruction-missing-precondition",
            target: { scope: "repository", name: "AGENTS.md" },
            title: "t",
            description: "d",
            suggested_fix: "f",
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(noted, 0, "journal note");
    const { bin } = fakeHerdr(root);
    const run = runTool(
      root,
      bin,
      ["remove", "--repo", clone, "--branch", "feat/y"],
      // The caller's own checkout, as a hook or a parent session leaves them.
      { JIG_CONSUMER_ROOT: clone, GIT_DIR: join(clone, ".git") },
    );
    expectSpawnExit(run, 0, "remove");
    expect(run.stdout.toString()).toContain('"parked":1');
  });

  test("a Herdr row naming another path is refused before anything runs", () => {
    const { root, clone } = fixture({ remove: 'touch "$HOME/remove-ran"' });
    const { bin, log } = fakeHerdr(root, [
      {
        branch: "feat/y",
        path: join(root, "elsewhere"),
        open_workspace_id: "w2",
      },
    ]);
    const run = runTool(root, bin, [
      "remove",
      "--repo",
      clone,
      "--branch",
      "feat/y",
    ]);
    expectSpawnExit(run, 1, "remove");
    expect(run.stderr.toString()).toContain("not removing either");
    expect(existsSync(join(root, "remove-ran"))).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("worktree remove");
  });

  test("a failing remove hook keeps the worktree", () => {
    const { root, clone } = fixture({ remove: "exit 4" });
    const { bin, log } = fakeHerdr(root);
    const run = runTool(root, bin, [
      "remove",
      "--repo",
      clone,
      "--branch",
      "feat/y",
    ]);
    expectSpawnExit(run, 1, "remove");
    expect(
      existsSync(log) && readFileSync(log, "utf8").includes("worktree remove"),
    ).toBe(false);
  });
});

test("the plugin event runs the create hook in the worktree it names", () => {
  const { root, worktree } = fixture({ create: 'pwd > "$HOME/create-ran-in"' });
  const run = runTool(root, join(root, "no-bin"), ["created"], {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      data: { worktree: { path: worktree } },
    }),
  });
  expectSpawnExit(run, 0, "created");
  expect(readFileSync(join(root, "create-ran-in"), "utf8").trim()).toBe(
    worktree,
  );
});

test("a command line that is not one of the commands is a usage error", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-cli-"));
  expectSpawnExit(runTool(root, root, ["frobnicate"]), 2, "unknown command");
  expectSpawnExit(
    runTool(root, root, ["open", "--repo", "/r"]),
    2,
    "missing --branch",
  );
  expectSpawnExit(
    runTool(root, root, [
      "open",
      "--repo",
      "/r",
      "--branch",
      "b",
      "--prompt",
      "p",
    ]),
    2,
    "--prompt without --key",
  );
});
