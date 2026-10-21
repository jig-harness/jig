import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import {
  awaitCreateHook,
  createdWorktreePath,
  HOOKS_DIR,
  hookPath,
  runCreateHook,
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
function fakeHerdr(root: string): { bin: string; log: string } {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "herdr.log");
  writeFakeProgram(
    join(bin, "herdr"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "worktree list") echo '{"result":{"worktrees":[]}}' ;;
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
  env: Record<string, string> = {},
) {
  return Bun.spawnSync([process.execPath, TOOL, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      JIG_HOME: join(root, ".jig"),
      JIG_USER_LAYER: "off",
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
