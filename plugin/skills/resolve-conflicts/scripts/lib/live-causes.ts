/**
 * The causes of the conflicts of an operation in progress, from the stages
 * its snapshot stored. The regions are found again by merging the three
 * versions of each text file with `git merge-file` and the histogram diff
 * that `git merge` uses, not read from the snapshot's hunks, which lose an
 * empty side and, in git's default conflict style, carry no merge base. The
 * cause rules are the replay's own (`path-record.ts`). Git before 2.44 has no
 * `--diff-algorithm` for `merge-file`; there the merge runs with its default
 * diff, which can place region boundaries differently. A repository's merge
 * drivers and renormalization do not apply to this second merge.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { type Cause, primaryCause } from "./causes.ts";
import {
  type PathSetup,
  pathRecord,
  releaseVersionFiles,
} from "./path-record.ts";
import { type ConflictedPath, Git } from "./replay.ts";
import type { Kind, PathEntry } from "./snapshot.ts";

export interface PathCauses {
  /** The causes of the path's regions, or its one path-level cause, in cause order. */
  causes: Cause[];
  /** The cause that stands for the path (`primaryCause`). */
  cause: Cause;
  /** How many conflicting regions the path has; 0 without text regions. */
  regions: number;
}

/**
 * What the rules read beyond the three versions: the release step's version
 * files. A lockfile or generated file is already classified by the snapshot,
 * so no generated entry is looked up again. An invalid changelog
 * configuration leaves the version rule off rather than stop a record.
 */
export function liveSetup(root: string): PathSetup {
  let versionFiles: PathSetup["versionFiles"] = [];
  try {
    versionFiles = releaseVersionFiles(root);
  } catch (err) {
    swallow(err, "without the version files the version rule settles nothing");
  }
  return { entries: [], versionFiles };
}

/** Git's own name for the conflict a snapshot kind describes. */
const GIT_CONFLICT: Record<Kind, string> = {
  "both-modified": "contents",
  "both-added": "add/add",
  "both-deleted": "rename/delete",
  "deleted-by-ours": "modify/delete",
  "deleted-by-theirs": "modify/delete",
  "added-by-ours": "file/directory",
  "added-by-theirs": "file/directory",
};

function blobOf(git: Git, stage: { blob: string } | null): Buffer | null {
  if (stage === null) return null;
  const r = git.raw(["cat-file", "blob", stage.blob]);
  return r.code === 0 ? r.stdout : null;
}

const isBinary = (bytes: Buffer): boolean =>
  bytes.subarray(0, 8000).includes(0);

/** The three versions merged with conflict markers (diff3), or null when git cannot or they are not text. */
function markedTree(
  git: Git,
  objects: Record<"base" | "ours" | "theirs", Buffer | null>,
  markerSize: number,
): Buffer | null {
  const { ours, theirs } = objects;
  if (ours === null || theirs === null) return null;
  // A file both sides added has no base: merge it against nothing, without
  // a base section, as the replay's regions of such a file have none.
  const base = objects.base ?? Buffer.alloc(0);
  if ([base, ours, theirs].some(isBinary)) return null;
  const dir = mkdtempSync(join(tmpdir(), "jig-live-causes-"));
  try {
    const files = [ours, base, theirs].map((bytes, i) => {
      const file = join(dir, String(i));
      writeFileSync(file, bytes);
      return file;
    });
    const merge = (algorithm: string[]) =>
      git.raw([
        "merge-file",
        "-p",
        ...algorithm,
        ...(objects.base === null ? [] : ["--diff3"]),
        `--marker-size=${markerSize}`,
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
        ...files,
      ]);
    // The exit status counts the conflicts, capped at 127; more is a failure.
    const done = (r: ReturnType<typeof merge>) => r.code >= 0 && r.code < 128;
    const histogram = merge(["--diff-algorithm=histogram"]);
    if (done(histogram)) return histogram.stdout;
    const fallback = merge([]);
    return done(fallback) ? fallback.stdout : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The causes of one path of the operation in progress. */
export function pathCauses(
  git: Git,
  path: string,
  entry: PathEntry,
  setup: PathSetup,
): PathCauses {
  const objects = {
    base: blobOf(git, entry.stages.base),
    ours: blobOf(git, entry.stages.ours),
    theirs: blobOf(git, entry.stages.theirs),
  };
  const conflicted: ConflictedPath = {
    path,
    stages: entry.stages,
    conflicts:
      entry.class === "binary" ? ["binary"] : [GIT_CONFLICT[entry.kind]],
    messages: [],
  };
  const record = pathRecord(
    git,
    conflicted,
    entry.markerSize,
    { tree: markedTree(git, objects, entry.markerSize), ...objects },
    setup,
  );
  const regions = record.regions.length;
  if (entry.class === "lockfile" || entry.class === "generated")
    return { causes: ["derived"], cause: "derived", regions };
  return {
    causes: record.causes,
    cause: primaryCause(record.causes, record.regions),
    regions,
  };
}

/**
 * The causes of every conflicted path in `paths`. A path that merged cleanly
 * (recorded for an adjustment) had no conflict and is left out, as is a path
 * whose causes cannot be told; its caller records it without one.
 */
export function snapshotCauses(
  root: string,
  paths: Readonly<Record<string, PathEntry>>,
): Map<string, PathCauses> {
  const found = new Map<string, PathCauses>();
  const git = new Git(root);
  const setup = liveSetup(root);
  for (const [path, entry] of Object.entries(paths)) {
    if (entry.clean === true) continue;
    try {
      found.set(path, pathCauses(git, path, entry, setup));
    } catch (err) {
      swallow(err, `the cause of ${path} is left out of the record`);
    }
  }
  return found;
}
