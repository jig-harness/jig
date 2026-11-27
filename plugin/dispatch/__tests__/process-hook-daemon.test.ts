/**
 * dispatch --apply through a whole tick on `runtime: process`, in a
 * repository whose worktree create hook leaves a daemon running in the new
 * worktree (as a build tool's install does): the daemon is the dispatcher's
 * own preparation, so the pickup it was prepared for launches in the same
 * tick. A process the dispatcher did not start, working in the item's
 * workspace, still holds the pickup with the message it always gave.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { HOOK_WORKTREE_ENV } from "../../shared/worktree-hooks.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

/**
 * A create hook that starts a daemon in a session of its own, so it leaves
 * the hook's process group and outlives it, working in the new worktree,
 * and records the daemon's pid where the test can end it.
 */
const DAEMON_HOOK = `#!/bin/sh
setsid sh -c 'echo $$ > "$HOOK_DAEMON_PIDS/daemon-$$"; exec sleep 600' </dev/null >/dev/null 2>&1 &
exit 0
`;

/** What the world's fakes read, kept in the environment the runtime gives its passes and probes. */
const FAKES = [
  "DISPATCH_FAKE_DIR",
  "LEDGER_FAKE_DIR",
  "DRIVE_PR_STATE_DIR",
  "JIG_GITHUB_GRAPHQL_URL",
  "JIG_DISPATCH_DRIVE_SCRIPT",
  "JIG_DISPATCH_DOCTOR_SCRIPT",
  "JIG_USER_LAYER",
  "GH_TOKEN",
];

let current: World | null = null;
const spawned: number[] = [];
let pidDir: string | null = null;

/** Every pid the hook's daemons recorded. */
function daemonPids(): number[] {
  if (pidDir === null || !existsSync(pidDir)) return [];
  return readdirSync(pidDir).map((name) =>
    Number(readFileSync(join(pidDir as string, name), "utf8").trim()),
  );
}

afterEach(() => {
  for (const pid of [...spawned.splice(0), ...daemonPids()])
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has ended already.
    }
  pidDir = null;
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** Run `git` in the world's clone. */
function git(w: World, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", w.repo, ...args], {
    env: w.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
}

/** Issue #12 assigned to the factory identity, `pickup` enabled, on the process runtime, with `hook` as the repository's create hook. */
function fixture(hook: string | null): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  if (hook !== null) {
    const dir = join(w.repo, ".config", "worktree-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "create"), hook);
    chmodSync(join(dir, "create"), 0o755);
    git(w, "add", ".config/worktree-hooks/create");
    git(
      w,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.com",
      "commit",
      "-q",
      "-m",
      "add a create hook",
    );
  }
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { runtime: "process", process: { env_keep: FAKES } },
    ["pickup"],
  );
  pidDir = join(w.root, "daemon-pids");
  mkdirSync(pidDir, { recursive: true });
  return w;
}

/** One tick with `--apply` on the process runtime, without a service manager or Orca. */
async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"], undefined, {
    XDG_RUNTIME_DIR: join(w.root, "absent-manager"),
    ORCA_CLI_COMMAND: join(w.root, "must-not-run-orca"),
    HOOK_DAEMON_PIDS: pidDir ?? "",
  });
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: { repos: Array<{ launches: unknown[] }> }) =>
  (r.repos[0]?.launches ?? []) as Array<Record<string, unknown>>;

describe.skipIf(process.platform !== "linux")(
  "a process runtime pickup and its worktree's processes",
  () => {
    it("launches in the tick that prepared it, beside the daemon its create hook left", async () => {
      const w = fixture(DAEMON_HOOK);
      const receipt = await tick(w);
      const [started] = launches(receipt);
      expect(started).toMatchObject({
        action: "pickup",
        target: "#12",
        outcome: "launched",
      });
      const record = readRecord(String(started?.record), dispatchState(w));
      const path = realpathSync(record?.workspace?.path ?? "");
      // The daemon outlived the hook and works in the new worktree.
      await waitFor("the daemon's pid", () => daemonPids().length === 1);
      const [daemon] = daemonPids();
      expect(daemon).toBeNumber();
      expect(readlinkSync(`/proc/${daemon}/cwd`)).toBe(path);
      await waitFor("the pass", () => claudeRuns(w).length === 1);
    }, 60_000);

    it("still holds a pickup whose workspace a process the dispatcher did not start works in", async () => {
      const w = fixture(null);
      const tree = join(w.root, "ws-12");
      git(w, "worktree", "add", "-q", "-b", "12-issue-12", tree, "main");
      // A person's shell, and one whose environment names another worktree as a hook's.
      for (const env of [{}, { [HOOK_WORKTREE_ENV]: realpathSync(w.repo) }]) {
        const shell = Bun.spawn(["sleep", "600"], {
          cwd: tree,
          env: { ...w.env, ...env },
          stdio: ["ignore", "ignore", "ignore"],
        });
        spawned.push(shell.pid);
        await waitFor("the shell", () => {
          try {
            return (
              readlinkSync(`/proc/${shell.pid}/cwd`) === realpathSync(tree)
            );
          } catch {
            return false;
          }
        });
      }
      const receipt = await tick(w);
      expect(launches(receipt)).toEqual([]);
      expect(JSON.stringify(receipt.repos[0])).toContain(
        `workspace ${tree} has 2 terminal(s) whose agents the runtime cannot report`,
      );
      expect(claudeRuns(w)).toEqual([]);
    }, 60_000);
  },
);
