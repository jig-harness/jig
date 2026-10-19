/**
 * The attributes the commit carries: those of the regular `.gitattributes`
 * files in the index, and nothing else. Every git command the check runs
 * whose result depends on attributes (classification, the automatic-merge
 * reconstruction) runs through `indexAttributesGit`. Read any other way, a
 * file the commit does not carry decides: the working tree's untracked,
 * ignored or unstaged `.gitattributes`; a staged link of that name, whose
 * target text git reads from the index as if it were attributes (a checkout
 * ignores such a link); `$GIT_DIR/info/attributes`; the file
 * `core.attributesFile` names; or the system's attributes file. Nor does any
 * configuration decide, since configuration is what turns an attribute into
 * behavior (a merge driver's command, above all).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw, splitNul, type GitResult } from "./git.ts";

/**
 * Settings for git calls on a throwaway index: none that would set a flag on
 * an entry on the way in (`core.ignorestat` marks each staged entry
 * assume-unchanged) or split the index across files.
 */
export const THROWAWAY_INDEX_CONFIG = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.ignorestat=false",
];

const REGULAR_ATTRIBUTES_FILE =
  /^100(?:644|755) [0-9a-f]+ 0\t(?:.*\/)?\.gitattributes$/s;

/** Variables that would point git at the repository's git directory itself. */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_ATTR_SOURCE",
];

/**
 * Settings that decide which renames and which history a merge finds and
 * what content it compares, and nothing else: the one configuration the
 * reconstruction takes from the repository as it stands, so that it finds
 * what the operation itself found. `merge.renormalize` normalizes the three
 * stages before the content merge, and `core.autocrlf` decides that
 * normalization where no attribute does.
 */
const MERGE_SETTINGS = [
  "merge.renames",
  "merge.directoryRenames",
  "merge.renameLimit",
  "merge.renormalize",
  "diff.renames",
  "diff.renameLimit",
  "core.autocrlf",
  "core.useReplaceRefs",
];

/** The merge settings in effect for the repository, as `-c` arguments. */
function mergeSettings(root: string): string[] {
  return MERGE_SETTINGS.flatMap((key) => {
    const r = gitRaw(root, ["config", "--get", key]);
    return r.code === 0 ? ["-c", `${key}=${r.stdout.trim()}`] : [];
  });
}

/** Variables that carry configuration into git besides its files. */
const CONFIGURATION_VARIABLE =
  /^GIT_CONFIG(?:|_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM|_NOSYSTEM)$/;

/** A tree holding the index's regular, staged `.gitattributes` files. */
function indexAttributesTree(root: string, scratch: string): string {
  const records = splitNul(git(root, ["ls-files", "--stage", "-z"])).filter(
    (record) => REGULAR_ATTRIBUTES_FILE.test(record),
  );
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  git(
    root,
    [...THROWAWAY_INDEX_CONFIG, "update-index", "-z", "--index-info"],
    records.map((record) => `${record}\0`).join(""),
    env,
  );
  return git(
    root,
    [...THROWAWAY_INDEX_CONFIG, "write-tree"],
    undefined,
    env,
  ).trim();
}

/** A git runner that reads attributes from the index only. */
export type IndexAttributesGit = (
  args: readonly string[],
  input?: string,
) => GitResult;

/**
 * Mirror the git directory `source` into `target`, entry by entry, leaving
 * out `except`: a directory is linked, a file copied (git refuses a `HEAD`
 * that is a link anywhere but into `refs/`). Nothing the runner does writes
 * to a mirrored file.
 */
function mirror(source: string, target: string, except: ReadonlySet<string>) {
  mkdirSync(target);
  for (const name of readdirSync(source)) {
    if (except.has(name)) continue;
    const from = join(source, name);
    const to = join(target, name);
    try {
      if (statSync(from).isDirectory()) symlinkSync(from, to, "junction");
      else copyFileSync(from, to);
    } catch (error) {
      // A lock file git removed meanwhile, or a dangling link: nothing to read.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * The repository's git directories without the configuration and
 * `info/attributes`: everything else a merge reads there (references, replace
 * refs among them, `HEAD`, `shallow`, `info/grafts`, the `modules`
 * directory) is the repository's own. The index is not copied: the runner
 * reads the repository's own (`GIT_INDEX_FILE`). The configuration keeps
 * only the repository's format (`core.repositoryformatversion` and its
 * `extensions`), without which its objects and references cannot be read.
 */
function mirrorGitDir(root: string, scratch: string): string {
  const path = (...args: string[]) =>
    git(root, ["rev-parse", "--path-format=absolute", ...args]).trim();
  const gitDir = path("--absolute-git-dir");
  const commonDir = path("--git-common-dir");
  const common = join(scratch, "common");
  mirror(commonDir, common, new Set(["config", "info", "index"]));
  const info = join(commonDir, "info");
  if (existsSync(info))
    mirror(info, join(common, "info"), new Set(["attributes"]));
  const format = gitRaw(root, [
    "config",
    "--local",
    "--get-regexp",
    "^(core\\.repositoryformatversion|extensions\\..*)$",
  ]);
  writeFileSync(join(common, "config"), "");
  for (const line of format.code === 0 ? format.stdout.split("\n") : []) {
    const at = line.indexOf(" ");
    if (at > 0)
      git(null, [
        "config",
        "--file",
        join(common, "config"),
        line.slice(0, at),
        line.slice(at + 1),
      ]);
  }
  if (gitDir === commonDir) return common;
  // A linked worktree's own directory: its HEAD and per-worktree refs.
  const worktree = join(scratch, "git");
  mirror(gitDir, worktree, new Set(["commondir", "config.worktree", "index"]));
  writeFileSync(join(worktree, "commondir"), `${common}\n`);
  return worktree;
}

/**
 * Run `body` with a git runner whose only attributes are the index's
 * `.gitattributes` files, passed as `--attr-source` (Git 2.41). The runner
 * works in a mirror of the repository's git directories that leaves out
 * their configuration and `info/attributes` (`mirrorGitDir`), so a merge
 * reads the repository's own references, index, history and submodule
 * repositories; `core.attributesFile` names an
 * empty file and `GIT_ATTR_NOSYSTEM` drops the system's file. Objects are the
 * repository's own (`GIT_OBJECT_DIRECTORY`), so what it writes, an automatic
 * merge's tree, is readable from the repository afterwards, and so is its
 * index (`GIT_INDEX_FILE`) and working tree (`GIT_WORK_TREE`).
 * `--attr-source` takes precedence over the working tree's and the index's
 * `.gitattributes` files, so they still decide nothing. No configuration is
 * read but the repository's format: not the repository's settings, the
 * user's (`GIT_CONFIG_GLOBAL` names an empty file), the system's
 * (`GIT_CONFIG_NOSYSTEM`), nor any passed in the environment, except the
 * settings that decide rename detection, renormalization and replacement
 * objects, passed on as the repository has them. So a merge driver configured anywhere does not
 * run, and a merge's result is git's for the attributes the commit carries.
 */
export function indexAttributesGit<T>(
  root: string,
  body: (run: IndexAttributesGit) => T,
): T {
  const scratch = mkdtempSync(join(tmpdir(), "resolve-conflicts-attributes-"));
  try {
    const tree = indexAttributesTree(root, scratch);
    const path = (name: string) =>
      git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
      ]).trim();
    const objects = path("objects");
    const index = path("index");
    const workTree = git(root, ["rev-parse", "--show-toplevel"]).trim();
    const gitDir = mirrorGitDir(root, scratch);
    const noAttributes = join(scratch, "attributes");
    writeFileSync(noAttributes, "");
    const noConfiguration = join(scratch, "config");
    writeFileSync(noConfiguration, "");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of REPOSITORY_VARIABLES) delete env[name];
    for (const name of Object.keys(env))
      if (CONFIGURATION_VARIABLE.test(name)) delete env[name];
    Object.assign(env, {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_INDEX_FILE: index,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: noConfiguration,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    const prefix = [
      ...mergeSettings(root),
      "-c",
      `core.attributesFile=${noAttributes}`,
      `--attr-source=${tree}`,
    ];
    return body((args, input) =>
      gitRaw(root, [...prefix, ...args], input, env),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
