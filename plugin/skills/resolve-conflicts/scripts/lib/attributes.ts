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
  mkdtempSync,
  rmSync,
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

/** Variables that would point git back at the repository's own git directory. */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_ATTR_SOURCE",
];

/**
 * Settings that decide how a merge detects renames, and nothing else: the one
 * configuration the reconstruction takes from the repository as it stands, so
 * that it detects the renames the operation itself detected.
 */
const RENAME_SETTINGS = [
  "merge.renames",
  "merge.directoryRenames",
  "merge.renameLimit",
  "diff.renames",
  "diff.renameLimit",
];

/** The rename settings in effect for the repository, as `-c` arguments. */
function renameSettings(root: string): string[] {
  return RENAME_SETTINGS.flatMap((key) => {
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
 * Run `body` with a git runner whose only attributes are the index's
 * `.gitattributes` files, passed as `--attr-source` (Git 2.41). The runner
 * works in a scratch git directory created without templates, so its
 * `info/attributes` does not exist; `core.attributesFile` names an empty file
 * and `GIT_ATTR_NOSYSTEM` drops the system's file. Objects are the
 * repository's own (`GIT_OBJECT_DIRECTORY`), so what it writes, an automatic
 * merge's tree, is readable from the repository afterwards. No configuration
 * is read: not the repository's, the user's (`GIT_CONFIG_GLOBAL` names an
 * empty file), the system's (`GIT_CONFIG_NOSYSTEM`), nor any passed in the
 * environment, except the settings that decide rename detection, passed on
 * as the repository has them. So a merge driver configured anywhere does not
 * run, and a merge's result is git's for the attributes the commit carries.
 */
export function indexAttributesGit<T>(
  root: string,
  body: (run: IndexAttributesGit) => T,
): T {
  const scratch = mkdtempSync(join(tmpdir(), "resolve-conflicts-attributes-"));
  try {
    const tree = indexAttributesTree(root, scratch);
    const objects = git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();
    const format = git(root, ["rev-parse", "--show-object-format"]).trim();
    const gitDir = join(scratch, "git");
    git(null, [
      "init",
      "--bare",
      "--quiet",
      "--template=",
      `--object-format=${format}`,
      gitDir,
    ]);
    // A shallow clone's merge base is computed within the history it has.
    const shallow = git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "shallow",
    ]).trim();
    if (existsSync(shallow)) copyFileSync(shallow, join(gitDir, "shallow"));
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
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: noConfiguration,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    const prefix = [
      ...renameSettings(root),
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
