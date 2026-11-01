/**
 * The pull request's `## Deferred` section: where a deferred finding is
 * recorded when no tracker adapter can file it
 * (references/deferral-protocol.md § Deferral without a tracker).
 *
 * The section sits in the pull request body between two hidden markers, so a
 * person's edits anywhere else in the body are never touched, and each entry
 * between its own pair, keyed on the finding's source url (the review thread,
 * or the summary comment and the finding's fingerprint). An entry quotes the
 * finding, says why it was deferred and links its source; `file-deferred.ts`
 * replaces it with the issue it filed. This module is pure: it parses and
 * rewrites body text, and `pr-body.ts` reads and writes the body.
 */

/** The body cannot take or give up an entry as asked. */
export class DeferredSectionError extends Error {
  override name = "DeferredSectionError";
}

export const SECTION_START = "<!-- jig-deferred -->";
export const SECTION_END = "<!-- /jig-deferred -->";
const ENTRY_END = "<!-- /deferred-entry -->";
const SECTION_HEADING = "## Deferred";

/** The anchor a reply links the section by: GitHub's id for the heading. */
export const SECTION_ANCHOR = "deferred";

/** One deferred finding, as the section records it. */
export interface DeferredEntry {
  /** The review thread's url, or the summary comment's for a summary finding. */
  source: string;
  /** A summary finding's fingerprint: with `source`, its identity. */
  fingerprint?: string;
  /** The tracker issue it was filed as, once `file-deferred.ts` filed it. */
  filed?: { key: string; url: string | null };
  /** The entry's text between its markers, as it stands in the body. */
  text: string;
}

/** A url or key fit to sit inside an HTML comment on one line. */
function inert(value: string): string {
  if (/[\s<>]|--/.test(value))
    throw new DeferredSectionError(
      `'${value}' cannot key a deferred entry (whitespace, <, > or --)`,
    );
  return value;
}

interface EntryId {
  source: string;
  fingerprint?: string;
}

function sameEntry(a: EntryId, b: EntryId): boolean {
  return a.source === b.source && a.fingerprint === b.fingerprint;
}

function entryStart(id: EntryId, filed?: DeferredEntry["filed"]): string {
  const fields = [
    ...(id.fingerprint === undefined ? [] : [`fp=${inert(id.fingerprint)}`]),
    ...(filed === undefined ? [] : [`filed=${inert(filed.key)}`]),
    ...(filed?.url == null ? [] : [`url=${inert(filed.url)}`]),
  ];
  return `<!-- deferred-entry: ${[inert(id.source), ...fields].join(" ")} -->`;
}

const ENTRY_START = /^<!-- deferred-entry: (\S+)((?: \w+=\S+)*) -->$/;

/** The section's inner text, and where it sits; `null` when the body has none. */
function locate(
  body: string,
): { before: string; inner: string; after: string } | null {
  const start = body.indexOf(SECTION_START);
  if (start === -1) return null;
  // The closing marker counts only at the start of a line: the section
  // writes it there, and every payload line is quoted or escaped.
  const close = body.indexOf(`\n${SECTION_END}`, start + SECTION_START.length);
  const end = close === -1 ? -1 : close + 1;
  if (end === -1)
    throw new DeferredSectionError(
      "the pull request body opens a deferred section it never closes: restore the closing marker before deferring again",
    );
  return {
    before: body.slice(0, start),
    inner: body.slice(start + SECTION_START.length, end),
    after: body.slice(end + SECTION_END.length),
  };
}

/** Every entry of the body's section, in order; `[]` when there is none. */
export function deferredEntries(body: string): DeferredEntry[] {
  const at = locate(body.replaceAll("\r", ""));
  if (at === null) return [];
  const out: DeferredEntry[] = [];
  const lines = at.inner.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = ENTRY_START.exec(lines[i] ?? "");
    if (m === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j] !== ENTRY_END) {
      if (ENTRY_START.test(lines[j] ?? ""))
        throw new DeferredSectionError(
          `the deferred entry for ${m[1]} opens another before it ends: restore its closing marker before deferring again`,
        );
      j++;
    }
    if (j === lines.length)
      throw new DeferredSectionError(
        `the deferred entry for ${m[1]} never ends: restore its closing marker before deferring again`,
      );
    out.push(entryFrom(m, lines.slice(i + 1, j)));
    i = j + 1;
  }
  return out;
}

/** One entry from its start marker's match and the lines up to its end marker. */
function entryFrom(m: RegExpExecArray, text: string[]): DeferredEntry {
  const fields = new Map(
    (m[2] ?? "")
      .trim()
      .split(" ")
      .filter(Boolean)
      // Split on the first `=` only: a url value can carry its own.
      .map((f): [string, string] => [
        f.slice(0, f.indexOf("=")),
        f.slice(f.indexOf("=") + 1),
      ]),
  );
  const key = fields.get("filed");
  const fingerprint = fields.get("fp");
  return {
    source: m[1] ?? "",
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(key === undefined
      ? {}
      : { filed: { key, url: fields.get("url") ?? null } }),
    text: text.join("\n").trim(),
  };
}

/**
 * `text` with every HTML comment opener escaped, so no payload can carry one
 * of the section's own markers; it renders as the same characters.
 */
function escaped(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

/** The finding quoted as a Markdown blockquote, every line of it. */
function quoted(finding: string): string {
  return escaped(finding)
    .trim()
    .split("\n")
    .map((l) => (l.trim() === "" ? ">" : `> ${l}`))
    .join("\n");
}

function entryBlock(id: EntryId, finding: string, reason: string): string {
  if (/[\n\r]/.test(reason))
    throw new DeferredSectionError("the reason must be one line");
  return [
    entryStart(id),
    `**[The finding](${id.source})**, deferred: ${escaped(reason)}`,
    "",
    quoted(finding),
    ENTRY_END,
  ].join("\n");
}

function filedBlock(
  entry: DeferredEntry,
  key: string,
  url: string | null,
): string {
  const link = url === null ? key : `[${key}](${url})`;
  return [
    entryStart(entry, { key, url }),
    `**[The finding](${entry.source})**: filed as ${link}.`,
    ENTRY_END,
  ].join("\n");
}

function sectionWith(inner: string): string {
  return `${SECTION_START}${inner}${SECTION_END}`;
}

/**
 * `body` with the finding added to its section, the section created at the
 * end of the body when it has none. An entry already there for `source` is
 * left as it is, so a re-run after a crash adds nothing twice.
 */
export function withDeferredEntry(
  body: string,
  entry: EntryId & { finding: string; reason: string },
): { body: string; added: boolean } {
  const text = body.replaceAll("\r", "");
  if (deferredEntries(text).some((e) => sameEntry(e, entry)))
    return { body: text, added: false };
  const block = entryBlock(entry, entry.finding, entry.reason);
  const at = locate(text);
  if (at === null) {
    const intro =
      "Findings deferred from this pull request where no tracker adapter could file them. `file-deferred.ts` files each one and replaces it with its issue.";
    const section = `${SECTION_HEADING}\n\n${sectionWith(`\n${intro}\n\n${block}\n`)}`;
    const base = text.trimEnd();
    return {
      body: base === "" ? `${section}\n` : `${base}\n\n${section}\n`,
      added: true,
    };
  }
  const inner = `${at.inner.trimEnd()}\n\n${block}\n`;
  return { body: `${at.before}${sectionWith(inner)}${at.after}`, added: true };
}

/** `body` with the entry `id` names replaced by the issue it was filed as. */
export function withFiledEntry(
  body: string,
  id: EntryId,
  issue: { key: string; url: string | null },
): string {
  const text = body.replaceAll("\r", "");
  const at = locate(text);
  const entries = deferredEntries(text);
  const index = entries.findIndex((e) => sameEntry(e, id));
  const entry = entries[index];
  if (at === null || entry === undefined)
    throw new DeferredSectionError(
      `no deferred entry for ${id.source} in the pull request body`,
    );
  const lines = at.inner.split("\n");
  const first = lines.flatMap((l, i) => (ENTRY_START.test(l) ? [i] : []))[
    index
  ] as number;
  let last = first + 1;
  while (last < lines.length && lines[last] !== ENTRY_END) last++;
  const replaced = [
    ...lines.slice(0, first),
    ...filedBlock(entry, issue.key, issue.url).split("\n"),
    ...lines.slice(last + 1),
  ].join("\n");
  return `${at.before}${sectionWith(replaced)}${at.after}`;
}
