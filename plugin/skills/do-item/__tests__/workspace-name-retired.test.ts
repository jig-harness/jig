/**
 * A workspace keeps the name it was created with: no shipped script or skill
 * text renames an Orca worktree (`worktree set --display-name`) or a Herdr
 * workspace (`workspace rename`), and the retired `workspace_name` section
 * a repository's file may still set is read past. The dispatcher names a
 * workspace once, at creation (`--name`), which is not a rename.
 */
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const PLUGIN = join(import.meta.dir, "..", "..", "..");
const SCRIPTS = join(import.meta.dir, "..", "scripts");
const RENAMES = [/--display-name/, /workspace["',\s]+rename\b/];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("no shipped plugin file renames a workspace", () => {
  const glob = new Bun.Glob("**/*.{ts,md,json,yaml}");
  const offenders: string[] = [];
  for (const path of glob.scanSync({ cwd: PLUGIN })) {
    const parts = path.split(/[\\/]/);
    if (parts.includes("__tests__") || parts.includes("node_modules")) continue;
    const text = readFileSync(join(PLUGIN, path), "utf8");
    if (RENAMES.some((pattern) => pattern.test(text))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});

test("the tracker scripts read a file that still sets workspace_name", () => {
  const dir = mkdtempSync(join(tmpdir(), "do-item-workspace-name-"));
  dirs.push(dir);
  const overlay = join(dir, "overlay.yaml");
  writeFileSync(
    overlay,
    "issue_tracker:\n  adapter: linear\n  team: ENG\nworkspace_name:\n  template: '{id} {status} {title}'\n  statuses: { ready: '[R]' }\n",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  env.JIG_OVERLAY = overlay;
  for (const op of ["states", "labels"]) {
    const r = spawnSync(process.execPath, [join(SCRIPTS, "tracker.ts"), op], {
      encoding: "utf8",
      env,
    });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
      op,
    );
  }
});
