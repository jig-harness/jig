/**
 * Read-only access to a repository for the detector and the skills that
 * judge what it finds: a program run without a shell, the forge's answers
 * through `gh`, the package scripts, and whether a shell runs a file
 * directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../config-layers.ts";

interface RunResult {
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
 * Whether a shell runs the tracked `file` (of stat `mode`) directly. Windows'
 * file system has no executable bit, so there the index's is read: the one a
 * checkout elsewhere takes.
 */
export function runsDirectly(
  root: string,
  file: string,
  mode: number,
): boolean {
  if (process.platform !== "win32") return (mode & 0o111) !== 0;
  const listed = run("git", ["ls-files", "-s", "--", `:(top,literal)${file}`], {
    cwd: root,
  });
  return listed.code === 0 && listed.stdout.startsWith("100755 ");
}

/**
 * The text entries of a list field. A field of the wrong type is a finding
 * of its own where a skill judges the configuration; a reader takes only the
 * entries that could work.
 */
export function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}
