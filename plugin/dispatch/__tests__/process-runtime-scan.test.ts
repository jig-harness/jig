/**
 * The process runtime lists a repository's sessions from one scan of the
 * host's processes, whatever the number of its worktrees: a scan per worktree
 * is a blocking spawn each, on the event loop every repository's observe
 * shares.
 */
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { localProbe } from "../lib/runtime/process.ts";

const WORKTREES = 12;

it.skipIf(process.platform === "win32")(
  "scans the host once for every worktree of a repository",
  () => {
    const root = mkdtempSync(join(tmpdir(), "process-scan-"));
    try {
      const home = join(root, "home");
      const repo = join(root, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      const git = (...argv: string[]) => {
        const out = Bun.spawnSync(
          [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-C",
            repo,
            ...argv,
          ],
          { env: { ...process.env, HOME: home } },
        );
        expectSpawnExit(out, 0);
      };
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "fixture");
      for (let i = 0; i < WORKTREES; i++)
        git("worktree", "add", "-q", "-b", `b${i}`, join(root, `wt${i}`));
      const fixture = join(root, "fixture.ts");
      writeFileSync(
        fixture,
        `
import { processRuntime } from ${JSON.stringify(resolve(import.meta.dir, "../lib/runtime/process.ts"))};
const calls: string[][] = [];
const holder = ${JSON.stringify(join(root, "wt3"))};
const runtime = processRuntime(
  { runtimeTimeoutMs: 8_000, workspaceTimeoutMs: 8_000 },
  async (argv) => {
    calls.push(argv);
    return {
      status: 0,
      stdout: "/proc/1\\t/\\n/proc/4242\\t" + holder + "/sub\\n",
      stderr: "",
    };
  },
);
const listed = await runtime.sessions(
  { path: ${JSON.stringify(repo)}, slug: "example-org/example-repo", defaultBranch: "main" },
  { keys: null, branchPattern: "", pullRequests: [] },
);
if (!listed.ok) throw new Error(listed.reason);
console.log(JSON.stringify({
  calls: calls.length,
  trees: listed.workspaces.length,
  unverifiable: Object.fromEntries(
    listed.workspaces.map((w) => [w.path.split("/").pop(), w.unverifiableTerminals]),
  ),
}));
`,
      );
      const child = Bun.spawnSync([process.execPath, fixture], {
        cwd: root,
        env: { ...process.env, HOME: home },
      });
      expectSpawnExit(child, 0);
      const seen = JSON.parse(child.stdout.toString().trim());
      expect(seen.trees).toBe(WORKTREES + 1);
      expect(seen.calls).toBe(1);
      // Each worktree is judged on the one answer: only the one a process works in has a terminal.
      expect(seen.unverifiable.wt3).toBe(1);
      expect(seen.unverifiable.wt0).toBe(0);
      expect(seen.unverifiable.repo).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "reads a probe a signal ended part way through as no answer, and keeps messages untranslated",
  async () => {
    const probe = localProbe(10);
    const whole = await probe(["sh", "-c", 'printf "%s" "$LC_ALL"']);
    expect(whole).toEqual({ status: 0, stdout: "C", stderr: "" });
    const killed = await probe([
      "sh",
      "-c",
      "printf '/proc/1\\t/\\n'; kill -9 $$",
    ]);
    expect(killed.status).toBe(-1);
  },
);
