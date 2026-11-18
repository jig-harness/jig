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
import { isShipped } from "../../../../tools/plugin/artifact.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const PLUGIN = join(import.meta.dir, "..", "..", "..");
const SCRIPTS = join(import.meta.dir, "..", "scripts");
// The raw text is scanned, with no comment or string handling to get wrong. A
// file is an offender when `workspace` is followed directly by `rename`: only
// separators (whitespace, commas, brackets, a spread, a line continuation, a
// quote, a comment) may sit between the two words, and a quote or backslash
// may split `rename` itself, as a shell reads `r"ename"`. A word that merely
// appears elsewhere in the file is no association, so unrelated operations
// pass; an operation bound to a variable before the call is not followed.
const SEPARATORS = String.raw`(?:[\s,.\[\]()"'\`\\]|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
const SPLIT = String.raw`["'\\]*`;
const HERDR_RENAME = new RegExp(
  `\\bworkspace${SEPARATORS}${[..."rename"].join(SPLIT)}(?![a-z])`,
);
const RENAMES = [/--display-name/, HERDR_RENAME];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("the Herdr recognizer sees quoting and comment variants and ignores unrelated operations", () => {
  for (const text of [
    'run(["workspace", "rename", id, name])',
    "run(['workspace', 'rename', id, name])",
    'run(["workspace", /* op */ "rename", id, name])',
    "run(['workspace', // operation\n'rename', id, name])",
    'run(["workspace", `rename`, id, name])',
    "herdr workspace rename w1 name",
    "herdr workspace \\\nrename w1 name",
    "cd //tmp; herdr workspace rename w1 name",
    'run(["workspace", ...["rename", id, name]])',
    'herdr workspace r"ename" w1 name',
    "herdr workspace re\\name w1 name",
    `run([\n  "workspace",\n${" ".repeat(60)}"rename", id, name])`,
  ])
    expect(HERDR_RENAME.test(text)).toBe(true);
  for (const text of [
    'run(["workspace", "list"])',
    "workspace renamed",
    "rename the file in this directory",
    'const workspace = getWorkspace(); run(["git", "remote", "rename", "a", "b"])',
    'run(["workspace", "list"]); // the next filesystem operation is "rename"',
    'const workspace = getWorkspace(); run(["git", "remote", "rename", "a", "b"])',
    'run(["workspace", "list"]); // the next filesystem operation is "rename"',
  ])
    expect(HERDR_RENAME.test(text)).toBe(false);
});

test("no shipped plugin file renames a workspace", () => {
  const glob = new Bun.Glob("**/*");
  // dot: shipped hidden directories (.claude-plugin, .codex-plugin) count.
  const offenders: string[] = [];
  for (const path of glob.scanSync({ cwd: PLUGIN, dot: true })) {
    if (path.split(/[\\/]/).includes("node_modules")) continue;
    if (!isShipped(`plugin/${path.replaceAll("\\", "/")}`)) continue;
    const bytes = readFileSync(join(PLUGIN, path));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
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
    if (!k.startsWith("GIT_") && !k.startsWith("JIG") && v !== undefined)
      env[k] = v;
  env.JIG_OVERLAY = overlay;
  env.JIG_USER_LAYER = "off";
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
