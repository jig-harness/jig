/**
 * The attributes the commit carries: those of the regular `.gitattributes`
 * files in the index. Every git command the check runs that reads attributes
 * (classification, the staged-marker scan, the automatic-merge
 * reconstruction) takes them from one tree built from those files, passed as
 * `--attr-source`. Read any other way, a file the commit does not carry
 * decides: the working tree's untracked, ignored or unstaged `.gitattributes`,
 * or a staged link of that name, whose target text git reads from the index
 * as if it were attributes (a checkout ignores such a link).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, splitNul } from "./git.ts";

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

/** A tree holding the index's regular, staged `.gitattributes` files. */
function indexAttributesTree(root: string): string {
  const records = splitNul(git(root, ["ls-files", "--stage", "-z"])).filter(
    (record) => REGULAR_ATTRIBUTES_FILE.test(record),
  );
  const dir = mkdtempSync(join(tmpdir(), "resolve-conflicts-attributes-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The global option that makes a git command read the index's attributes:
 * put it before the command (`git --attr-source=<tree> check-attr …`).
 * Requires Git 2.41.
 */
export function indexAttrSource(root: string): string {
  return `--attr-source=${indexAttributesTree(root)}`;
}
