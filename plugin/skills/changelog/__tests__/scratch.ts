/**
 * Scratch repositories for the changelog skill's tests: a changelog, notes
 * and manifests under git, and a way to run the skill's commands in one from
 * outside this repository, the way the plugin cache does.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  parseChangelogSection,
  type Resolved,
  resolve,
} from "../scripts/config.ts";
import { workingTree } from "../scripts/notes-dir.ts";

/** What marks a CI job, which would change what the commands do. */
const CI_MARKERS = [
  "CI",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
];

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The test environment without anything that points git or Jig elsewhere. */
export function cleanEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG__") &&
      !key.startsWith("GITHUB_") &&
      !CI_MARKERS.includes(key) &&
      key !== "JIG_OVERLAY" &&
      key !== "JIG_CONSUMER_ROOT"
    )
      env[key] = value;
  return {
    ...env,
    GIT_AUTHOR_NAME: "Alex Author",
    GIT_AUTHOR_EMAIL: "alex@example.com",
    GIT_COMMITTER_NAME: "Alex Author",
    GIT_COMMITTER_EMAIL: "alex@example.com",
    ...extra,
  };
}

/** Run git in `root` with `extra` in its environment; its output. */
export function gitAt(
  root: string,
  extra: Record<string, string>,
  ...args: string[]
): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: cleanEnv(extra),
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export function git(root: string, ...args: string[]): string {
  return gitAt(root, {}, ...args);
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Write `files` and commit them as `author` (a name), with `subject`. */
export function commit(
  root: string,
  files: Record<string, string>,
  subject: string,
  author = "Alex Author",
): void {
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  gitAt(
    root,
    { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "a@example.com" },
    "commit",
    "-qm",
    subject,
  );
}

/** A temporary directory removed after the file's tests. */
export function temporary(prefix = "changelog-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * The `git clone` option that checks files out as committed. Git for Windows
 * turns core.autocrlf on machine-wide, which would write every checked-out
 * text file with CRLF line endings and change the bytes the tests compare.
 */
export const KEEP_LF = ["-c", "core.autocrlf=false"];

/** A git repository on `main` holding `files`, committed as `base`. */
export function repository(files: Record<string, string>): string {
  const root = temporary();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/** The configuration `section` (over `file: CHANGELOG.md`) resolved against `root`'s working tree. */
export function resolvedFor(
  root: string,
  section: Record<string, unknown> = {},
): Resolved {
  const config = parseChangelogSection({ file: "CHANGELOG.md", ...section });
  if (config === null) throw new Error("the section sets no file");
  return resolve(root, config, workingTree(root));
}

/** A `.config/jig.yaml` with the `changelog:` section `yaml` (already indented two spaces). */
export const jigYaml = (yaml: string): string => `changelog:\n${yaml}\n`;

export const MANIFEST = (v: string): string =>
  `{\n  "name": "p",\n  "version": "${v}"\n}\n`;

export const KEEP_CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Changed

- an earlier docs change

## [1.2.0] - 2026-01-02

### Added

- a skill

[Unreleased]: https://example.com/r/compare/v1.2.0...HEAD
[1.2.0]: https://example.com/r/compare/v1.1.0...v1.2.0
`;

export const COMMON_CHANGELOG = `# Changelog

## [1.2.0] - 2026-01-02

### Added

- A skill ([#1](https://github.com/o/r/pull/1)) (Alex Author)

[1.2.0]: https://github.com/o/r/releases/tag/v1.2.0
`;
