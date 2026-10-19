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
import { isMapping } from "../../../../shared/config-layers.ts";
import {
  manifestVersion,
  pluginVersion,
} from "../../../../shared/plugin-version.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export { trackedFiles } from "../../../adr/scripts/locate.ts";
export { pluginVersion };

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

/**
 * Whether the repository at `root` holds `commit`: a record or report naming
 * a commit it does not have was made for another repository.
 */
export function hasCommit(root: string, commit: string): boolean {
  return (
    run("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }).code ===
    0
  );
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

/** Whether `dir` holds an installed plugin of `version`: a manifest that names it. */
function installedAs(dir: string, version: string): boolean {
  return (
    statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
    manifestVersion(dir) === version
  );
}

/** Compare two `major.minor.patch` versions; `next` sorts last, a malformed one first. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    if (v === NEXT_VERSION) return [Number.POSITIVE_INFINITY, 0, 0];
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
/**
 * What a `since` names before its release: a branch cannot know the version
 * it ships in, so the release step (changes/README.md) writes it.
 */
export const NEXT_VERSION = "next";
/** Whether `value` is a `since`: a version, or `next` before the release. */
export function isSince(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === NEXT_VERSION || VERSION_PATTERN.test(value))
  );
}
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

/**
 * A newer version of this plugin installed beside the one running, or
 * `null`. Plugin caches keep each version in a folder named after it
 * (`<plugin>/<version>/skills/…`); a session keeps the version it started
 * with, so an update reaches the next session, not this one. A folder counts
 * only with a manifest naming its version: an interrupted install or a stray
 * file is nothing a restart could load. `pluginDir` is the running plugin's
 * root; a checkout has no version folders beside it.
 */
export function newerInstalledVersion(
  pluginDir = join(skillDir(), "..", ".."),
  running = pluginVersion(),
): string | null {
  if (running === null) return null;
  let siblings: string[];
  try {
    siblings = readdirSync(dirname(pluginDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const newer = siblings
    .filter(
      (v) =>
        VERSION_PATTERN.test(v) &&
        compareVersions(v, running) > 0 &&
        installedAs(join(dirname(pluginDir), v), v),
    )
    .sort(compareVersions);
  return newer.at(-1) ?? null;
}
