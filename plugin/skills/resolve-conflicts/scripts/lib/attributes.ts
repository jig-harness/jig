/**
 * The attributes the commit carries: those of the regular `.gitattributes`
 * files in the index, and nothing else. Every git command the check runs
 * whose result depends on attributes (classification, the automatic-merge
 * reconstruction) runs through `indexAttributesGit`. Read any other way, a
 * file the commit does not carry decides: the working tree's untracked,
 * ignored or unstaged `.gitattributes`; a staged link of that name, whose
 * target text git reads from the index as if it were attributes (a checkout
 * ignores such a link); `$GIT_DIR/info/attributes`; the file
 * `core.attributesFile` names; or the system's attributes file.
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
 * merge's tree, is readable from the repository afterwards. The repository's
 * configuration is not read either, so a merge driver it configures does not
 * run.
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of REPOSITORY_VARIABLES) delete env[name];
    Object.assign(env, {
      GIT_DIR: gitDir,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    const prefix = [
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
