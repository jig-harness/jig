/**
 * Read-only access to the repository under audit: its tracked files, its
 * commands, and the forge's answers through `gh`.
 *
 * A probe reads tracked files only, so an untracked scratch file or an ignored
 * build output never counts as a practice the repository has, and a draft
 * record refuses a checkout whose tracked files differ from the commit it
 * names. A derivation reads the checkout as the skills would run in it, and
 * flags a configured program that is present but not tracked.
 */
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export { trackedFiles } from "../../../adr/scripts/locate.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a program without a shell. A program that cannot start, or that runs
 * past the deadline, is reported like a failed run (code -1) with the reason
 * in `stderr`, so a caller treats it as an unanswered question.
 */
export function run(
  program: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): RunResult {
  const result = spawnSync(program, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error)
    return { code: -1, stdout: "", stderr: result.error.message };
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** `gh` with JSON output parsed, or the reason it gave none. */
export function ghJson(
  args: string[],
  cwd: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const result = run("gh", args, { cwd });
  if (result.code !== 0)
    return {
      ok: false,
      reason: (result.stderr || result.stdout).trim() || `exit ${result.code}`,
    };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: "gh returned no JSON" };
  }
}

/** The repository's `package.json` scripts, or `null` without one. */
export function packageScripts(root: string): Record<string, string> | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
  const scripts = isMapping(manifest) ? manifest.scripts : undefined;
  if (!isMapping(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Whether `path` matches `glob`, ignoring letter case: repositories spell
 * `AGENTS.md`, `Agents.md` and `agents.md` alike, and a probe asks whether
 * the file exists, not how it is capitalised. A glob without a `/` matches
 * at the repository root only; write `**\/<name>` to match anywhere.
 */
export function matchGlob(glob: string, path: string): boolean {
  return new Bun.Glob(glob.toLowerCase()).match(path.toLowerCase());
}

/** This skill's own directory, wherever the plugin was installed. */
export function skillDir(): string {
  return dirname(dirname(import.meta.dir));
}

/**
 * The plugin version this skill belongs to, from its manifest, or `null`
 * when neither manifest is beside it.
 */
export function pluginVersion(): string | null {
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    const path = join(skillDir(), "..", "..", manifest, "plugin.json");
    if (!existsSync(path)) continue;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = isMapping(parsed) ? parsed.version : undefined;
    if (typeof version === "string") return version;
  }
  return null;
}

/** Compare two `major.minor.patch` versions; a malformed one sorts first. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? match.slice(1).map(Number) : [-1, -1, -1];
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `v` is a real calendar date written YYYY-MM-DD. */
export function isDate(v: string): boolean {
  if (!DATE_PATTERN.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(v);
}

/** Today's date on this machine, as YYYY-MM-DD. */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
