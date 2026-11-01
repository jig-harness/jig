/**
 * The glossary's entries, read from GLOSSARY.md.
 *
 * An entry is a top-level list item that opens with a bold term and an em
 * dash: `- **SSoT (single source of truth)** — the one authoritative place…`,
 * under a `## Group` heading. Its anchor comes from the term before any
 * parenthesis (`ssot`), so the anchors stay short and survive a reworded
 * expansion. The documents link to the glossary without an anchor, by the
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

export function parseGlossary(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  let group = "";
  let current: GlossaryEntry | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^## (.+)/.exec(line)?.[1];
    if (heading) {
      group = heading.trim();
      current = null;
      continue;
    }
    const m = /^- \*\*(.+?)\*\* — (.*)$/.exec(line);
    if (m?.[1]) {
      const term = m[1].replace(/`/g, "");
      const base = /^(.*?)\s*\(/.exec(term)?.[1] ?? term;
      let anchor = slug(base);
      for (let n = 2; seen.has(anchor); n++) anchor = `${slug(base)}-${n}`;
      seen.add(anchor);
      current = {
        term,
        anchor,
        group,
        definition: m[2] ?? "",
        names: namesOf(term),
      };
      entries.push(current);
    } else if (current && /^\s{2,}\S/.test(line))
      current.definition += ` ${line.trim()}`;
    else if (!line.trim()) current = null;
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
