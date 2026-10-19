// Writing change notes into a Common Changelog file (common-changelog.org).
// There is no Unreleased section: notes wait until one asks for a release,
// and then all go into it. Each entry ends with a reference to the change and
// its authors, and a release gets a link definition.
import { ChangelogError } from "./errors.ts";
import type { ChangeNote } from "./change-notes.ts";
import { COMMON_CHANGELOG, releaseVersion } from "./formats.ts";
import { trailingLinks } from "./keep-a-changelog.ts";
import { fenced, heading } from "./markdown-blocks.ts";
import type { HostLinks } from "./remote.ts";
import { type ApplyOptions, mergeSections, render } from "./sections.ts";

/** What the repository's history says about one note. */
export interface Credit {
  /** The pull request number, or the short hash of the commit that brought the note in. */
  reference: { pullRequest: number } | { commit: string } | null;
  /** The people the entry credits, never a bot; empty when none are credited. */
  authors: string[];
}

export interface CommonOptions extends ApplyOptions {
  /** The newest release the changelog already lists; null for the first release. */
  previous: string | null;
}

const BREAKING = /^[-*] \*\*Breaking:\*\*/;

/** Whether an entry is marked as breaking. */
export const isBreaking = (entry: string): boolean => BREAKING.test(entry);

/** The reference the format puts after an entry, linked when the host is known. */
function referenceText(
  reference: Credit["reference"],
  links: HostLinks | null,
): string {
  if (reference === null) return "";
  if ("pullRequest" in reference) {
    const label = `#${reference.pullRequest}`;
    return links
      ? `([${label}](${links.pullRequest(reference.pullRequest)}))`
      : `(${label})`;
  }
  const label = `\`${reference.commit}\``;
  return links
    ? `([${label}](${links.commit(reference.commit)}))`
    : `(${label})`;
}

/**
 * A name as literal Markdown text. Names come from git history and from a
 * note's front matter, after the note's own Markdown was checked, so every
 * character that could start markup or HTML is escaped.
 */
export const literalName = (name: string): string =>
  name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]()<>#!|~&]/g, "\\$&");

/**
 * The note with each entry ended by the reference to its change and the
 * credited authors, as the format writes them: `- Change ([#1](…)) (Jane Doe)`.
 */
export function credited(
  note: ChangeNote,
  credit: Credit,
  links: HostLinks | null,
): ChangeNote {
  const names = credit.authors.map(literalName).filter(Boolean);
  const suffix = [
    referenceText(credit.reference, links),
    names.length ? `(${names.join(", ")})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...note,
    sections: new Map(
      [...note.sections].map(([title, items]) => [
        title,
        items.map((item) =>
          suffix ? withSuffix(item.trimEnd(), suffix, note.file) : item,
        ),
      ]),
    ),
  };
}

/** The HTML of `markdown` up to its last text, the closing tags dropped. */
const openRendering = (markdown: string): string =>
  Bun.markdown.html(markdown).replace(/(<\/[a-z]+>\s*)+$/, "");

/**
 * The entry with `suffix` appended, refused when appending changes how the
 * entry itself reads: an unmatched delimiter in the entry, a lone backtick
 * above all, would otherwise pair with one in the reference.
 */
function withSuffix(item: string, suffix: string, file: string): string {
  const entry = `${item} ${suffix}`;
  if (!openRendering(entry).startsWith(openRendering(item)))
    throw new ChangelogError(
      `${file}: the entry "${item}" reads differently once its reference and authors are appended, so an unmatched delimiter (such as a lone backtick) in it pairs with one in them: close or escape it`,
    );
  return entry;
}

/** A reference of each kind the format appends, with a credited name. */
const PROBES: Credit[] = [
  { reference: { pullRequest: 1 }, authors: ["A"] },
  { reference: { commit: "0000000" }, authors: ["A"] },
];

/**
 * Why the release would refuse to credit `note`: each kind of reference the
 * format can append is tried on every entry, so a note the branch check
 * passes is one the release can write.
 */
export function creditRefusals(
  note: ChangeNote,
  links: HostLinks | null,
): string[] {
  const refusals = new Set<string>();
  for (const credit of PROBES) {
    try {
      credited(note, credit, links);
    } catch (error) {
      if (!(error instanceof ChangelogError)) throw error;
      refusals.add(error.message);
    }
  }
  return [...refusals];
}

/** The entries of one section with the breaking ones first, each group in its order. */
function breakingFirst(text: string): string {
  const items = text.split("\n");
  return [
    ...items.filter(isBreaking),
    ...items.filter((i) => !isBreaking(i)),
  ].join("\n");
}

/**
 * The changelog with the notes written in as one release, placed above the
 * newest one the file lists. Nothing is written when no note asks for a
 * release. Earlier releases are not touched.
 */
export function applyCommonChangelog(
  changelog: string,
  notes: ChangeNote[],
  options: CommonOptions,
): string {
  if (!notes.some((n) => n.release !== null)) return changelog;
  const { version, links } = options;
  if (!version)
    throw new ChangelogError(
      "notes ask for a release but no version was given",
    );
  if (!links)
    throw new ChangelogError(
      "this format links each release and change through the hosting service, and the origin remote is missing or on a host Jig has no links for (GitHub and GitLab): add an origin remote that points there",
    );
  const notices = notes.map((n) => n.lead).filter(Boolean);
  if (notices.length > 1)
    throw new ChangelogError(
      `a release has one notice, a single sentence, but ${notes
        .filter((n) => n.lead)
        .map((n) => n.file)
        .join(
          " and ",
        )} each write one: keep one and put the other's point in an entry`,
    );
  const lines = fenced(changelog);
  const releases = lines.flatMap(({ line, inFence }, i) => {
    const h = inFence ? null : heading(line);
    return h?.level === 2 && releaseVersion(h.title, COMMON_CHANGELOG) !== null
      ? [i]
      : [];
  });
  const defs = trailingLinks(lines);
  const at = releases[0] ?? defs;
  const text = (from: number, to: number) =>
    lines
      .slice(from, to)
      .map((l) => l.line)
      .join("\n");
  const tag = (v: string) => `${options.tagPrefix}${v}`;
  const section = render(
    `## [${version}] - ${options.date}`,
    notices.join(""),
    mergeSections([], notes, COMMON_CHANGELOG).map((b) => ({
      ...b,
      text: breakingFirst(b.text),
    })),
  );
  const link = `[${version}]: ${
    options.previous === null
      ? links.tag(tag(version))
      : links.compare(tag(options.previous), tag(version))
  }`;
  return `${[text(0, at).trimEnd(), section, text(at, defs).trimEnd()]
    .filter(Boolean)
    .join("\n\n")}\n\n${[link, text(defs, lines.length).trim()]
    .filter(Boolean)
    .join("\n")}\n`;
}
