// Writing change notes into a Keep a Changelog file.
import { ChangelogError } from "./errors.ts";
import type { ChangeNote } from "./change-notes.ts";
import { KEEP_A_CHANGELOG } from "./formats.ts";
import { blocks, fenced, heading, LINK_REF } from "./markdown-blocks.ts";
import { hostLinks } from "./remote.ts";
import { type ApplyOptions, mergeSections, render } from "./sections.ts";

export interface KeepOptions extends ApplyOptions {
  /** The version being replaced, for the comparison link. */
  previous: string;
  /** Whether this is the first release: no earlier release to compare with. */
  firstRelease: boolean;
}

/**
 * The index where the file's trailing run of link definitions and blank lines
 * starts; the file's length when it ends in neither.
 */
export function trailingLinks(lines: { line: string }[]): number {
  let at = lines.length;
  while (
    at > 0 &&
    (LINK_REF.test(lines[at - 1]?.line ?? "") || !lines[at - 1]?.line.trim())
  )
    at--;
  return at;
}

/** Where the changelog's Unreleased section and its headings are. */
interface Layout {
  lines: { line: string; inFence: boolean }[];
  /** The line index of each `##` heading. */
  headings: number[];
  /** The line index of the Unreleased heading; undefined when there is none. */
  start: number | undefined;
  /** The line index just past Unreleased (or the file's end when it has none). */
  end: number;
}

function layoutOf(changelog: string): Layout {
  const lines = fenced(changelog);
  const headings = lines.flatMap(({ line, inFence }, i) =>
    !inFence && heading(line)?.level === 2 ? [i] : [],
  );
  const start = headings.find((i) =>
    /^\[Unreleased\]/i.test(heading(lines[i]?.line ?? "")?.title ?? ""),
  );
  if (start === undefined) return { lines, headings, start, end: lines.length };
  const next = headings.find((i) => i > start);
  let end = next ?? lines.length;
  // Without a release section below it, the comparison links at the end of
  // the file are not part of Unreleased.
  if (next === undefined)
    while (
      end > start + 1 &&
      /^(\[[^\]]+\]: \S+\s*|)$/.test(lines[end - 1]?.line ?? "")
    )
      end--;
  return { lines, headings, start, end };
}

/** The new version's section: the summaries of the notes asking for a release, then every entry. */
function releaseSection(
  released: ChangeNote[],
  entries: ChangeNote[],
  options: KeepOptions,
): string {
  if (!options.version)
    throw new ChangelogError(
      "notes ask for a release but no version was given",
    );
  return render(
    `## [${options.version}] - ${options.date}`,
    released
      .map((n) => n.lead)
      .filter(Boolean)
      .join("\n\n"),
    mergeSections([], entries, KEEP_A_CHANGELOG),
  );
}

/**
 * The changelog with every note written in. With `unreleased: write`, a note
 * without a release joins `## [Unreleased]` and notes with one become the new
 * version's section, placed below Unreleased with their leads as its summary.
 * With `wait`, nothing is written until a note asks for a release, and then
 * every note goes into the new version's section; Unreleased is left as it
 * is, and a file without one is fine. When the file ends with comparison
 * links, Unreleased's moves on and the new version gets its own: a comparison
 * with the previous version, or the version's own tag for the first release.
 */
export function applyKeepAChangelog(
  changelog: string,
  notes: ChangeNote[],
  options: KeepOptions,
): string {
  const write = options.unreleased === "write";
  const released = notes.filter((n) => n.release !== null);
  if (!write && !released.length) return changelog;
  const { lines, headings, start, end } = layoutOf(changelog);
  if (start === undefined && write)
    throw new ChangelogError("the changelog has no `## [Unreleased]` section");
  const text = (from: number, to: number) =>
    lines
      .slice(from, to)
      .map((l) => l.line)
      .join("\n");
  const sections: string[] = [];
  // Where the new text goes: Unreleased is rewritten (write) or kept (wait);
  // without one, the release goes above the newest.
  let head: string;
  let tail: string;
  if (start !== undefined && write) {
    const unreleased = blocks(text(start + 1, end), 3);
    const pending = notes.filter((n) => n.release === null);
    sections.push(
      render(
        lines[start]?.line ?? "## [Unreleased]",
        unreleased.lead,
        mergeSections(unreleased.parts, pending, KEEP_A_CHANGELOG),
      ),
    );
    head = text(0, start);
    tail = text(end, lines.length);
  } else {
    const at =
      start === undefined ? (headings[0] ?? trailingLinks(lines)) : end;
    head = text(0, at);
    tail = text(at, lines.length);
  }
  if (released.length) {
    sections.push(releaseSection(released, write ? released : notes, options));
    tail = moveLinks(tail, options);
  }
  const trimmedTail = tail.replace(/^\n+/, "");
  return `${head.trimEnd()}\n\n${sections.join("\n\n")}\n${trimmedTail ? `\n${trimmedTail}` : ""}`.replace(
    /\n*$/,
    "\n",
  );
}

/**
 * Point Unreleased's comparison link past the new version and add the
 * version's own: what changed since the previous version, or, for the first
 * release, which has no previous tag to compare with, the version's tag.
 */
/**
 * The address of a tag, spelled as the host of the comparison links spells it
 * (GitLab keeps tags under `/-/tags/`); GitHub's form where the host is not
 * one Jig knows.
 */
function tagLink(base: string, tag: string): string {
  const repository = base.replace(/\/-$/, "");
  return hostLinks(repository)?.tag(tag) ?? `${repository}/releases/tag/${tag}`;
}

function moveLinks(tail: string, options: KeepOptions): string {
  const lines = tail.split("\n");
  const i = lines.findIndex((l) => /^\[Unreleased\]: /i.test(l));
  if (i === -1) return tail;
  const url = LINK_REF.exec(lines[i] ?? "")?.[2] ?? "";
  const base = /^(.*)\/compare\/[^/]+\.\.\.HEAD$/.exec(url)?.[1];
  if (!base) return tail;
  const tag = (v: string) => `${options.tagPrefix}${v}`;
  const version = options.version ?? "";
  lines.splice(
    i,
    1,
    `[Unreleased]: ${base}/compare/${tag(version)}...HEAD`,
    options.firstRelease
      ? `[${version}]: ${tagLink(base, tag(version))}`
      : `[${version}]: ${base}/compare/${tag(options.previous)}...${tag(version)}`,
  );
  return lines.join("\n");
}
