/**
 * The glossary's entries, read from GLOSSARY.md.
 *
 * An entry is a top-level list item that opens with a bold term and an em
 * dash: `- **SSoT (single source of truth)** — the one authoritative place…`,
 * under a `## Group` heading. A parenthesis after the bold term, before the
 * dash, qualifies it (`- **Trend** (audit) — …`): the page prints it with
 * the term, but it names nothing a link can use. An explicit `<a id="…"></a>`
 * anchor on the line before an entry or right after `- ` sets its anchor;
 * otherwise its anchor comes from the term before any parenthesis (`ssot`), so
 * the anchors stay short and survive a reworded expansion. The documents link to the glossary without an anchor, by the
 * term's own words in the link text; `anchorFor` finds the entry those words
 * name.
 */

export interface GlossaryEntry {
  /** The term as text: the page and the tooltips print it as it is, so a
   * code span's backticks are dropped. */
  term: string;
  anchor: string;
  group: string;
  /** The definition as written, Markdown, continuation lines joined. */
  definition: string;
  /** The words a link text may use for this entry, lowercased. */
  names: string[];
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The term's names: the term without its parenthesis, each side of a
 * `a / b` term, and the expansion inside the parenthesis.
 */
function namesOf(term: string): string[] {
  const names = new Set([term.toLowerCase()]);
  const paren = /\((.+?)\)/.exec(term)?.[1];
  const base = term
    .replace(/\s*\(.*?\)\s*/g, " ")
    .trim()
    .toLowerCase();
  for (const part of base.split(/\s*\/\s*/)) if (part) names.add(part);
  if (paren) names.add(paren.toLowerCase());
  return [...names];
}

/** An explicit HTML anchor written on its own line before a glossary entry. */
const STANDALONE_ANCHOR = /^<a\s+id="([^"]+)"><\/a>\s*$/;

/** A glossary list item, with an optional inline `<a id="..."></a>` before the bold term. */
const ENTRY_LINE =
  /^- (?:<a\s+id="([^"]+)"><\/a>\s*)?\*\*(.+?)\*\*( \([^)]*\))? — (.*)$/;

/** A unique anchor for an entry, honoring an explicit `<a id>` when present. */
function uniqueAnchor(preferred: string, seen: Set<string>): string {
  let anchor = preferred;
  for (let n = 2; seen.has(anchor); n++) anchor = `${preferred}-${n}`;
  seen.add(anchor);
  return anchor;
}

export function parseGlossary(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  let group = "";
  let current: GlossaryEntry | null = null;
  let pendingId: string | undefined;
  for (const line of markdown.split("\n")) {
    const heading = /^## (.+)/.exec(line)?.[1];
    if (heading) {
      group = heading.trim();
      current = null;
      pendingId = undefined;
      continue;
    }
    const standalone = STANDALONE_ANCHOR.exec(line)?.[1];
    if (standalone) {
      pendingId = standalone;
      current = null;
      continue;
    }
    const m = ENTRY_LINE.exec(line);
    if (m?.[2]) {
      const term = m[2].replace(/`/g, "");
      const base = /^(.*?)\s*\(/.exec(term)?.[1] ?? term;
      const anchor = uniqueAnchor(m[1] || pendingId || slug(base), seen);
      pendingId = undefined;
      current = {
        term: `${term}${m[3] ?? ""}`,
        anchor,
        group,
        definition: m[4] ?? "",
        names: namesOf(term),
      };
      entries.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.definition += ` ${line.trim()}`;
    } else if (!line.trim()) {
      current = null;
    } else {
      pendingId = undefined;
    }
  }
  return entries;
}

/** Words that name an entry by another form than its own. */
const ALIASES: Record<string, string> = { "de-scarred": "de-scarring" };

/** Simple singular forms of a lowercased phrase. */
function singulars(text: string): string[] {
  const out = [text];
  if (text.endsWith("ies")) out.push(`${text.slice(0, -3)}y`);
  if (text.endsWith("es")) out.push(text.slice(0, -2));
  if (text.endsWith("s")) out.push(text.slice(0, -1));
  return out;
}

/** An entry one of whose names starts or ends with the word, for a short link text. */
function partialMatch(
  entries: GlossaryEntry[],
  candidate: string,
): GlossaryEntry | undefined {
  if (candidate.length < 3) return undefined;
  return entries.find((e) =>
    e.names.some(
      (n) => n.startsWith(`${candidate} `) || n.endsWith(` ${candidate}`),
    ),
  );
}

/** The anchor of the entry a link text names, or null. */
export function anchorFor(
  entries: GlossaryEntry[],
  linkText: string,
): string | null {
  let text = linkText
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = ALIASES[text] ?? text;
  if (!text) return null;
  const candidates = singulars(text);
  for (const candidate of candidates)
    for (const e of entries) if (e.names.includes(candidate)) return e.anchor;
  for (const candidate of candidates) {
    const e = partialMatch(entries, candidate);
    if (e) return e.anchor;
  }
  return null;
}
