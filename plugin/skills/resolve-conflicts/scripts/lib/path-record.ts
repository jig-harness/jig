/**
 * The record of one conflicted path: its class, a cause for each conflicting
 * region and for the path as a whole, from the path's three versions. The
 * replay of a past merge and the live record of a resolution share it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { loadChangelogConfig } from "../../../changelog/scripts/config.ts";
import {
  derivedFiles,
  type VersionFile,
  versionSpan,
} from "../../../changelog/scripts/versions.ts";
import {
  type Cause,
  isMechanical,
  isProse,
  ordered,
  type Region,
  type RegionContext,
  type ReleaseField,
  regionCause,
  type SideName,
} from "./causes.ts";
import {
  type GeneratedEntry,
  type PathClass,
  regenerateFor,
} from "./classify.ts";
import { parseRegionLines } from "./markers.ts";
import type { ConflictedPath, Git } from "./replay.ts";
import type { PathRecord, RegionRecord } from "./report.ts";
import { kindOf } from "./snapshot.ts";

/** What the cause rules read beyond a path's three versions. */
export interface PathSetup {
  entries: GeneratedEntry[];
  versionFiles: VersionFile[];
}

/**
 * The files the release step writes the version into; none when the
 * changelog skill is off. Throws when the changelog configuration is invalid.
 */
export function releaseVersionFiles(root: string): VersionFile[] {
  const config = loadChangelogConfig(root);
  if (config === null) return [];
  if (config.version?.kind === "tags") return [];
  if (config.version?.kind === "files") return config.version.files;
  return derivedFiles((path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch (err) {
      swallow(err, `${path} is not readable: it holds no version`);
      return null;
    }
  });
}

function linesOf(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isBinaryBytes(bytes: Buffer | null): boolean {
  return bytes?.subarray(0, 8000).includes(0) ?? false;
}

/** Net lines `to` adds above each line of `from`, from the hunks of `git diff`. */
function netAboveReader(git: Git, from: string | null, to: string | null) {
  let hunks: { start: number; count: number; net: number }[] | null | undefined;
  return (line: number): number | null => {
    if (from === null || to === null) return null;
    if (hunks === undefined) {
      const r = git.raw([
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        from,
        to,
      ]);
      hunks =
        r.code === 0
          ? r.stdout
              .toString("utf8")
              .split("\n")
              .flatMap((l) => {
                const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
                if (!m) return [];
                const count = m[2] === undefined ? 1 : Number(m[2]);
                const added = m[3] === undefined ? 1 : Number(m[3]);
                return [{ start: Number(m[1]), count, net: added - count }];
              })
          : null;
    }
    if (hunks === null) return null;
    let net = 0;
    for (const h of hunks) {
      // A hunk that removes nothing inserts after its start line.
      const above =
        h.count === 0 ? h.start < line : h.start + h.count - 1 < line;
      if (above) net += h.net;
    }
    return net;
  };
}

function regionCauseOf(
  git: Git,
  conflicted: ConflictedPath,
  texts: Record<SideName, string | null>,
  versionFiles: VersionFile[],
) {
  // Every key configured for the path: a file can carry more than one release version.
  const release = (side: SideName): ReleaseField[] => {
    const text = texts[side];
    if (text === null) return [];
    return versionFiles.flatMap((file) => {
      if (file.path !== conflicted.path) return [];
      const span = versionSpan(file, text);
      if (span === null) return [];
      const [from, to] = span;
      const start = text.lastIndexOf("\n", from - 1) + 1;
      const end = text.indexOf("\n", from);
      const line = text.slice(start, end < 0 ? undefined : end);
      return [
        {
          version: text.slice(from, to),
          line: line.replace(/\r$/, ""),
          start: from - start,
          end: to - start,
        },
      ];
    });
  };
  const { base, ours, theirs } = conflicted.stages;
  const above = {
    ours: netAboveReader(git, base?.blob ?? null, ours?.blob ?? null),
    theirs: netAboveReader(git, base?.blob ?? null, theirs?.blob ?? null),
  };
  const ctx: RegionContext = {
    inBase: base !== null,
    file: {
      base: linesOf(texts.base),
      ours: linesOf(texts.ours),
      theirs: linesOf(texts.theirs),
    },
    release: {
      base: release("base"),
      ours: release("ours"),
      theirs: release("theirs"),
    },
    prose: isProse(conflicted.path),
    netAbove: (side, line) => above[side](line),
  };
  return (region: Region) => regionCause(region, ctx);
}

function hasStage(stages: ConflictedPath["stages"]): boolean {
  return stages.base !== null || stages.ours !== null || stages.theirs !== null;
}

/** The record of one conflicted path of a replayed merge. */
export function pathRecord(
  git: Git,
  conflicted: ConflictedPath,
  markerSize: number,
  objects: {
    tree: Buffer | null;
    base: Buffer | null;
    ours: Buffer | null;
    theirs: Buffer | null;
  },
  setup: PathSetup,
): PathRecord {
  const { path, stages } = conflicted;
  const derived = regenerateFor(path, setup.entries);
  const binary =
    [stages.base, stages.ours, stages.theirs].some(
      (s) => s?.mode === "160000",
    ) ||
    conflicted.conflicts.some(
      (t) => t === "binary" || t.startsWith("submodule"),
    ) ||
    [objects.base, objects.ours, objects.theirs].some(isBinaryBytes);
  const cls: PathClass = derived ? derived.class : binary ? "binary" : "text";
  const parsed =
    !binary && objects.tree !== null
      ? parseRegionLines(objects.tree.toString("utf8"), markerSize)
      : [];
  const decode = (b: Buffer | null) => (b === null ? null : b.toString("utf8"));
  const texts = {
    base: decode(objects.base),
    ours: decode(objects.ours),
    theirs: decode(objects.theirs),
  };
  const cause = derived
    ? null
    : regionCauseOf(git, conflicted, texts, setup.versionFiles);
  const regions: RegionRecord[] = parsed.map((r) => ({
    start: r.start,
    end: r.end,
    cause:
      cause === null
        ? "derived"
        : r.base === null
          ? "overlap"
          : cause({ ours: r.ours, base: r.base, theirs: r.theirs }),
    lines: {
      ours: r.ours.length,
      base: r.base?.length ?? 0,
      theirs: r.theirs.length,
    },
  }));
  const causes: Cause[] =
    regions.length > 0
      ? ordered(regions.map((r) => r.cause))
      : [pathLevelCause(conflicted, derived !== null, binary)];
  return {
    path,
    kind: hasStage(stages) ? kindOf(stages) : null,
    conflicts: conflicted.conflicts,
    class: cls,
    causes,
    regions,
    mechanical: causes.every(isMechanical),
    resolution: null,
  };
}

/** Git's kinds of conflict that leave text regions in the file. */
const TEXT_CONFLICTS = new Set(["contents", "add/add"]);

/**
 * The cause of a path with no region read: `derived` for a lockfile or a
 * generated file; `structural` when git reports the conflict without text
 * regions; `overlap` for a text conflict whose regions could not be read,
 * which settles nothing.
 */
export function pathLevelCause(
  conflicted: ConflictedPath,
  derived: boolean,
  binary: boolean,
): Cause {
  if (derived) return "derived";
  const textual =
    !binary &&
    conflicted.conflicts.length > 0 &&
    conflicted.conflicts.every((kind) => TEXT_CONFLICTS.has(kind));
  return textual ? "overlap" : "structural";
}
