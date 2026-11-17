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
// Comments are dropped by a scan that keeps string literals whole (a `//` in
// a URL string is not a comment), and shell line continuations are joined, so
// what is left is the command's own tokens: `workspace`, then any run of
// whitespace and punctuation (quotes, commas, brackets, a spread), then
// `rename`. A quote that never closes only keeps more text, which can add a
// detection and never hides one.
function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
const HERDR_RENAME = {
  test: (text: string): boolean =>
    /\bworkspace\b\W+rename\b/.test(
      withoutComments(text).replace(/\\\r?\n/g, " "),
    ),
};
const RENAMES = [/--display-name/, HERDR_RENAME];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("the Herdr recognizer sees quoting and comment variants", () => {
  for (const text of [
    'run(["workspace", "rename", id, name])',
    "run(['workspace', 'rename', id, name])",
    'run(["workspace", /* op */ "rename", id, name])',
    "run(['workspace', // operation\n'rename', id, name])",
    'run(["workspace", `rename`, id, name])',
    "herdr workspace rename w1 name",
    "herdr workspace \\\nrename w1 name",
    'run(["workspace", ...["rename", id, name]])',
    'const url = "https://example.invalid"; run(["herdr", "workspace", "rename", id, name]);',
    `run([\n  "workspace",\n${" ".repeat(60)}"rename", id, name])`,
  ])
    expect(HERDR_RENAME.test(text)).toBe(true);
  for (const text of [
    'run(["workspace", "list"])',
    "workspace renamed",
    'run(["workspace", /* rename */ "list"])',
    'run(["workspace", // rename\n"list"])',
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
