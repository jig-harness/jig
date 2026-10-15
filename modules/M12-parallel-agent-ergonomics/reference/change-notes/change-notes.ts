// Change notes: one small file per pull request in place of an edit to the
// changelog every pull request would otherwise touch. This file holds the pure
// part: reading a note, choosing the next version, and writing notes into a
// Keep a Changelog file. release.ts applies it to a repository after a merge;
// check.ts holds a branch to it before one.
import { posix } from "node:path";

/** How far a note moves the version, as semantic versioning names it. */
export type Bump = "patch" | "minor" | "major";
const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

/** Keep a Changelog 1.1.0's change types, in the order a section lists them. */
export const SECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

export interface ChangeNote {
  /** The note's file name, for messages. */
  file: string;
  /** The release the note asks for; null for a change that ships in none. */
  release: Bump | null;
  /** Prose before the first section: the release's summary. */
  lead: string;
  /** Each change type with its entries, every entry a top-level list item. */
  sections: Map<string, string[]>;
}

/**
 * The `]:` that closes a reference definition's label, which a note may not
 * hold. Matched anywhere in prose rather than at a line start: a definition
 * inside a list item or quote, or with its label wrapped across lines, is
 * still document-wide.
 */
const DEFINITION = /\]:/;

/** A line that opens a fenced code block, which a note may not hold. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/** A line of only `=` or `-`, which makes the line above it a heading. */
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Raw HTML: a `<` opening a tag, a comment or a declaration. An autolink
 * (`<https://…>`, `<a@b.c>`), an angle-bracketed link destination and an
 * escaped `\<` are not HTML.
 */
const HTML =
  /(?<![\\]|\]\()<(?![a-z][a-z0-9+.-]{1,31}:[^<>\s]*>|[^<>\s@]+@[^<>\s]+>)[a-z/!?]/i;

/**
 * An inline link's destination and optional title: a destination in `<…>`,
 * or a bare one without spaces or parentheses; a title in `"…"`, `'…'` or
 * `(…)`. A note's every `](` must match it, so the release step can rewrite
 * each link it holds.
 */
const LINK =
  /\]\((?:<([^<>\n]*)>|([^()\s<][^()\s]*))((?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?)\)/g;

interface Block {
  title: string;
  text: string;
}

/**
 * The lines of `text` with whether each sits inside a fenced code block, so a
 * heading shown as an example in the changelog is not read as structure. As
 * in CommonMark, a fence closes only on a line holding nothing but a run of
 * its own character at least as long as the one that opened it.
 */
function fenced(text: string): { line: string; inFence: boolean }[] {
  let fence: string | null = null;
  const lines: { line: string; inFence: boolean }[] = [];
  for (const line of text.split("\n")) {
    if (fence === null) {
      // A backtick fence's info string holds no backtick.
      const opener = /^\s*(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (opener) fence = opener;
      lines.push({ line, inFence: opener !== undefined });
      continue;
    }
    const closer = /^\s*(`+|~+)\s*$/.exec(line)?.[1];
    if (closer && closer[0] === fence[0] && closer.length >= fence.length)
      fence = null;
    lines.push({ line, inFence: true });
  }
  return lines;
}

/** An ATX heading's level and title, as Markdown renders it; null for any other line. */
function heading(line: string): { level: number; title: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return m?.[1] ? { level: m[1].length, title: (m[2] ?? "").trim() } : null;
}

/** Text before the first heading of `level`, then each heading with its text. */
function blocks(text: string, level: number): { lead: string; parts: Block[] } {
  const lead: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  for (const { line, inFence } of fenced(text)) {
    const h = inFence ? null : heading(line);
    if (h?.level === level) parts.push({ title: h.title, lines: [] });
    else (parts.at(-1)?.lines ?? lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    parts: parts.map((p) => ({
      title: p.title,
      text: p.lines.join("\n").trim(),
    })),
  };
}

/** The top-level list items of a section, each with its continuation lines. */
function entries(text: string): { items: string[]; stray: boolean } {
  const items: string[][] = [];
  let stray = false;
  for (const { line, inFence } of fenced(text)) {
    if (!inFence && /^[-*] /.test(line)) items.push([line]);
    else if (items.length) items[items.length - 1]?.push(line);
    else if (line.trim()) stray = true;
  }
  return { items: items.map((lines) => lines.join("\n").trimEnd()), stray };
}

/** The note's front matter: the release it asks for, and the body after it. */
function frontMatter(
  file: string,
  text: string,
  errors: string[],
): { body: string; release: Bump | null } {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) {
    if (text.startsWith("---\n"))
      errors.push(`${file}: front matter opened with --- is never closed`);
    return { body: text, release: null };
  }
  const values = (front[1] ?? "")
    .split("\n")
    .map((raw) => raw.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => releaseValue(file, line, errors))
    .filter((value) => value !== undefined);
  if (values.length > 1)
    errors.push(`${file}: front matter sets \`release\` twice`);
  return { body: text.slice(front[0].length), release: values[0] ?? null };
}

/**
 * The bump a front-matter line sets; null for a value that is not one, and
 * undefined for a line that is not `release:` at all. Quotes must pair.
 */
function releaseValue(
  file: string,
  line: string,
  errors: string[],
): Bump | null | undefined {
  const raw = /^release:\s*(.*)$/.exec(line)?.[1];
  if (raw === undefined) {
    errors.push(
      `${file}: front matter takes only \`release\`, found \`${line}\``,
    );
    return undefined;
  }
  const value = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  if ((BUMPS as readonly string[]).includes(value)) return value as Bump;
  errors.push(
    `${file}: release is one of ${BUMPS.join(", ")}, not \`${value}\``,
  );
  return null;
}

/** What is wrong with one `### <title>` section, if anything. */
function sectionProblem(
  title: string,
  seen: Map<string, string[]>,
  found: { items: string[]; stray: boolean },
): string | null {
  if (!(SECTIONS as readonly string[]).includes(title))
    return `\`### ${title}\` is not a change type (${SECTIONS.join(", ")})`;
  if (seen.has(title)) return `\`### ${title}\` appears twice`;
  if (found.stray)
    return `\`### ${title}\` has text outside a list item: write each change as a "- " item`;
  if (!found.items.length) return `\`### ${title}\` lists no change`;
  return null;
}

/**
 * What the note's body holds that the release step could not place. A note
 * holds only `###` sections, list items, paragraphs, inline links and code
 * spans: every other construct (a version-level heading, a reference
 * definition, a fenced code block, an underlined heading, raw HTML, a link
 * the step cannot rewrite) is refused, since each could change how the
 * changelog renders around the note, or what its links point at.
 */
function bodyProblems(file: string, body: string): string[] {
  const prose = paragraphs(body).flatMap((text) =>
    codeSpans(text).filter((_, i) => i % 2 === 0),
  );
  const refused = (rules: Rule[], text: string) =>
    rules
      .filter(([holds]) => holds(text))
      .map(([, why]) => `${file}: \`${text.trim()}\` — ${why}`);
  return [
    ...body.split("\n").flatMap((line) => refused(LINE_RULES, line)),
    ...prose.flatMap((text) => refused(PROSE_RULES, text)),
  ];
}

/** A construct a note may not hold, and why. */
type Rule = [(text: string) => boolean, string];

/** What one line of a note may not be. */
const LINE_RULES: Rule[] = [
  [
    (line) => FENCE.test(line),
    "a note holds no fenced code block; show code in a `code span`",
  ],
  [
    (line) => UNDERLINE.test(line),
    'a line of only = or - makes the line above it a heading; write each change as a "- " item',
  ],
  [
    (line) => (heading(line)?.level ?? 3) < 3,
    "a note starts at ### (Added, Changed, …); the release step writes the version heading",
  ],
];

/** What a note's prose, outside code spans, may not hold. */
const PROSE_RULES: Rule[] = [
  [
    (prose) => DEFINITION.test(prose),
    "write the link inline; a reference label is shared by every note in the changelog, so two notes could define it differently. Put a literal ]: in a code span",
  ],
  [
    (prose) => HTML.test(prose),
    "a note holds no raw HTML, which could hide or restyle the changelog after it; put a literal < in a code span or write \\<",
  ],
  [
    (prose) =>
      prose.split("](").length - 1 !== [...prose.matchAll(LINK)].length,
    'a link the release step cannot rewrite: write [text](path) with an optional "title", and put a destination holding a space or parenthesis in <…>',
  ],
];

/** The note's paragraphs: its lines, split at blank lines. */
function paragraphs(text: string): string[] {
  return text.split(/\n[ \t]*\n/).filter((p) => p.trim());
}

/**
 * Read one change note: optional front matter whose only key is
 * `release: patch|minor|major`, an optional lead, then `### <type>` sections
 * of list items. Returns the note, or what is wrong with it.
 */
export function parseNote(
  file: string,
  text: string,
): { note: ChangeNote | null; errors: string[] } {
  const errors: string[] = [];
  const { body, release } = frontMatter(
    file,
    text.replace(/\r\n/g, "\n"),
    errors,
  );
  errors.push(...bodyProblems(file, body));
  const { lead, parts } = blocks(body, 3);
  const sections = new Map<string, string[]>();
  for (const { title, text: sectionText } of parts) {
    const found = entries(sectionText);
    const problem = sectionProblem(title, sections, found);
    if (problem) errors.push(`${file}: ${problem}`);
    else sections.set(title, found.items);
  }
  if (!parts.length)
    errors.push(
      `${file}: a note lists its changes under at least one ### section (${SECTIONS.join(", ")})`,
    );
  if (lead && release === null)
    errors.push(
      `${file}: a lead summarises a release, so it needs \`release:\`; without one, list the change under a ### section`,
    );
  return errors.length
    ? { note: null, errors }
    : { note: { file, release, lead, sections }, errors };
}

/** The version after `current` for the largest of `bumps`; null when there are none. */
export function nextVersion(current: string, bumps: Bump[]): string | null {
  if (!bumps.length) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m)
    throw new Error(
      `cannot bump \`${current}\`: the release step moves only a plain major.minor.patch version`,
    );
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const largest = Math.max(...bumps.map((b) => BUMPS.indexOf(b)));
  if (largest === 2) return `${major + 1}.0.0`;
  if (largest === 1) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The note with its relative links rewritten from the note's directory to
 * the changelog's, so a link that works in the note works in the changelog.
 * A note's links are inline (parseNote refuses a reference definition), with
 * or without angle brackets around the destination. An absolute URL, a
 * root-relative path or an anchor is left as it is, and so is anything in a
 * code span, which shows a link rather than being one; a code span may run
 * over several lines of one paragraph, never past it.
 */
export function rebaseLinks(
  note: ChangeNote,
  fromDir: string,
  toDir: string,
): ChangeNote {
  const target = (to: string) =>
    /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(to)
      ? to
      : posix.relative(toDir, posix.join(fromDir, to)) || ".";
  const inline = (prose: string) =>
    prose.replace(
      LINK,
      (
        _,
        angled: string | undefined,
        bare: string | undefined,
        title: string,
      ) =>
        angled === undefined
          ? `](${target(bare ?? "")}${title})`
          : `](<${target(angled)}>${title})`,
    );
  const paragraph = (text: string) =>
    codeSpans(text)
      .map((part, i) => (i % 2 ? part : inline(part)))
      .join("");
  const rebase = (text: string) =>
    text
      .split(/(\n[ \t]*\n)/)
      .map((part, i) => (i % 2 ? part : paragraph(part)))
      .join("");
  return {
    ...note,
    lead: rebase(note.lead),
    sections: new Map(
      [...note.sections].map(([title, items]) => [title, items.map(rebase)]),
    ),
  };
}

/**
 * `text` split into prose and code spans, the code spans at odd indexes. A
 * span opens with a run of backticks and closes at the next run exactly as
 * long; a run nothing closes is literal text. In prose a backslash escapes
 * the character after it, so `\\\`` opens nothing; inside a span it does not.
 */
function codeSpans(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "`") end++;
    const close = new RegExp(`(?<!\`)\`{${end - i}}(?!\`)`, "g");
    close.lastIndex = end;
    const found = close.exec(text);
    if (!found) {
      i = end;
      continue;
    }
    const after = found.index + found[0].length;
    parts.push(text.slice(start, i), text.slice(i, after));
    start = i = after;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Each note's entries merged into `into` by change type, keeping types in order. */
function mergeSections(into: Block[], notes: ChangeNote[]): Block[] {
  const out = into.map((b) => ({ ...b }));
  for (const note of notes)
    for (const [title, items] of note.sections) {
      const existing = out.find((b) => b.title === title);
      if (existing) {
        existing.text = [existing.text, ...items].filter(Boolean).join("\n");
        continue;
      }
      const rank = SECTIONS.indexOf(title as (typeof SECTIONS)[number]);
      const after = out.findIndex(
        (b) =>
          SECTIONS.indexOf(b.title as (typeof SECTIONS)[number]) > rank &&
          (SECTIONS as readonly string[]).includes(b.title),
      );
      const block = { title, text: items.join("\n") };
      if (after === -1) out.push(block);
      else out.splice(after, 0, block);
    }
  return out;
}

function render(heading: string, lead: string, parts: Block[]): string {
  return [
    heading,
    ...(lead ? [lead] : []),
    ...parts.map((p) => `### ${p.title}\n\n${p.text}`),
  ].join("\n\n");
}

const LINK_REF = /^\[([^\]]+)\]: (\S+)\s*$/;

export interface ApplyOptions {
  /** The version the notes release; null when none asks for one. */
  version: string | null;
  /** The version being replaced, for the comparison link. */
  previous: string;
  /** The release date, year-month-day. */
  date: string;
  /** What a version's tag puts before it, such as `v`. */
  tagPrefix: string;
}

/**
 * The changelog with every note written in: a note without a release joins
 * `## [Unreleased]`; notes with one become the new version's section, placed
 * below Unreleased, with their leads as its summary. When the file ends with
 * comparison links, Unreleased's moves on and the new version gets its own.
 */
export function applyNotes(
  changelog: string,
  notes: ChangeNote[],
  options: ApplyOptions,
): string {
  const lines = fenced(changelog);
  const headings = lines.flatMap(({ line, inFence }, i) =>
    !inFence && heading(line)?.level === 2 ? [i] : [],
  );
  const start = headings.find((i) =>
    heading(lines[i]?.line ?? "")?.title.startsWith("[Unreleased]"),
  );
  if (start === undefined)
    throw new Error("the changelog has no `## [Unreleased]` section");
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
  const text = (from: number, to: number) =>
    lines
      .slice(from, to)
      .map((l) => l.line)
      .join("\n");
  const head = text(0, start);
  const unreleased = blocks(text(start + 1, end), 3);
  let tail = text(end, lines.length);

  const pending = notes.filter((n) => n.release === null);
  const released = notes.filter((n) => n.release !== null);
  const sections = [
    render(
      lines[start]?.line ?? "## [Unreleased]",
      unreleased.lead,
      mergeSections(unreleased.parts, pending),
    ),
  ];
  if (released.length) {
    if (!options.version)
      throw new Error("notes ask for a release but no version was given");
    sections.push(
      render(
        `## [${options.version}] - ${options.date}`,
        released
          .map((n) => n.lead)
          .filter(Boolean)
          .join("\n\n"),
        mergeSections([], released),
      ),
    );
    tail = moveLinks(tail, options);
  }
  const trimmedTail = tail.replace(/^\n+/, "");
  return `${head.trimEnd()}\n\n${sections.join("\n\n")}\n${trimmedTail ? `\n${trimmedTail}` : ""}`.replace(
    /\n*$/,
    "\n",
  );
}

/** Point Unreleased's comparison link past the new version and add the version's own. */
function moveLinks(tail: string, options: ApplyOptions): string {
  const lines = tail.split("\n");
  const i = lines.findIndex((l) => /^\[Unreleased\]: /.test(l));
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
    `[${version}]: ${base}/compare/${tag(options.previous)}...${tag(version)}`,
  );
  return lines.join("\n");
}

/** The changelog's `## [Unreleased]` section, heading and links aside, for comparing two revisions. */
export function unreleasedSection(changelog: string): string | null {
  const parts = blocks(changelog, 2).parts;
  const section = parts.find((p) => p.title.startsWith("[Unreleased]"));
  if (!section) return null;
  return section.text
    .split("\n")
    .filter((l) => !LINK_REF.test(l))
    .join("\n")
    .trim();
}

/** The versions the changelog has a section for, in order, Unreleased aside. */
export function releasedVersions(changelog: string): string[] {
  return blocks(changelog, 2).parts.flatMap((p) => {
    const m = /^\[([^\]]+)\]/.exec(p.title);
    return m?.[1] && m[1] !== "Unreleased" ? [m[1]] : [];
  });
}
