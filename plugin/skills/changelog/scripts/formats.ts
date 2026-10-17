// The changelog formats the skill writes, and what each one fixes: the change
// types a note may list and their order, whether the file has an Unreleased
// section, how a release heading reads, and which format a file is in.
import { blocks, fenced, heading } from "./markdown-blocks.ts";

export const FORMAT_IDS = ["keep-a-changelog", "common-changelog"] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export interface Format {
  id: FormatId;
  /** The change types a note lists under `###`, in the order a release lists them. */
  sections: readonly string[];
  /** Whether the file has an `## [Unreleased]` section. */
  hasUnreleased: boolean;
  /** Whether a note may name its authors and the release step credits them. */
  credits: boolean;
}

/** Keep a Changelog 1.1.0. */
export const KEEP_A_CHANGELOG: Format = {
  id: "keep-a-changelog",
  sections: ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"],
  hasUnreleased: true,
  credits: false,
};

/** Common Changelog 1.0.0. */
export const COMMON_CHANGELOG: Format = {
  id: "common-changelog",
  sections: ["Changed", "Added", "Removed", "Fixed"],
  hasUnreleased: false,
  credits: true,
};

const FORMATS: Record<FormatId, Format> = {
  "keep-a-changelog": KEEP_A_CHANGELOG,
  "common-changelog": COMMON_CHANGELOG,
};

export function formatOf(id: FormatId): Format {
  return FORMATS[id];
}

/**
 * The format a changelog file is in, when it says so: an `## [Unreleased]`
 * heading or a link to keepachangelog.com is Keep a Changelog, a link to
 * common-changelog.org is Common Changelog. Null for anything else, an empty
 * file included, and for a file that says both.
 */
export function detectFormat(text: string): Format | null {
  const keep =
    /keepachangelog\.com/i.test(text) ||
    fenced(text).some(
      ({ line, inFence }) =>
        !inFence && /^\[Unreleased\]/i.test(heading(line)?.title ?? ""),
    );
  const common = /common-changelog\.org/i.test(text);
  if (keep === common) return null;
  return keep ? KEEP_A_CHANGELOG : COMMON_CHANGELOG;
}

/**
 * The version a `##` heading's title names, when it is a release heading:
 * `[x.y.z] - date` in both formats, and in Common Changelog also the unlinked
 * `x.y.z - date`. Null for Unreleased and for any other heading.
 */
export function releaseVersion(title: string, format: Format): string | null {
  const linked = /^\[([^\]]+)\]/.exec(title)?.[1];
  if (linked !== undefined) return /^unreleased$/i.test(linked) ? null : linked;
  if (format.id !== "common-changelog") return null;
  return /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(title)?.[1] ?? null;
}

/** The versions the changelog has a section for, newest first as the file lists them. */
export function releasedVersions(changelog: string, format: Format): string[] {
  return blocks(changelog, 2).parts.flatMap((p) => {
    const version = releaseVersion(p.title, format);
    return version === null ? [] : [version];
  });
}

/** The changelog's `## [Unreleased]` section, heading and links aside, for comparing two revisions. */
export function unreleasedSection(changelog: string): string | null {
  const section = blocks(changelog, 2).parts.find((p) =>
    /^\[Unreleased\]/i.test(p.title),
  );
  if (!section) return null;
  return section.text
    .split("\n")
    .filter((l) => !/^\[[^\]]+\]: \S+\s*$/.test(l))
    .join("\n")
    .trim();
}
