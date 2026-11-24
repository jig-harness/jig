/**
 * Markdown escaping of the sheet kit. Every markdown projection of
 * a sheet source writes source text through these, so source text is always
 * literal text and never markup.
 */

/**
 * Source text is literal text, never markup: escape every character that
 * Markdown or an inline HTML comment would act on. Backslash goes first, in
 * the same pass, so an existing backslash cannot cancel the escape added
 * before a pipe. Block syntax is decided at the start of a line, so leading
 * indentation is dropped (it would open a code block) and a leading `-`, `+`,
 * `=` or list number is escaped (thematic break, setext heading, list).
 */
const markdownText = (value: string, startsLine: boolean) => {
  const prefixed = startsLine ? value : `x${value}`;
  const rendered = prefixed
    .replace(/^[ \t]+/gm, "")
    .replace(/[\\`*_[\]<>|&#~]/g, "\\$&")
    .replace(/^([-+=])/gm, "\\$1")
    .replace(/^(\d{1,9})([.)])/gm, "$1\\$2");
  return startsLine ? rendered : rendered.slice(1);
};

/**
 * A whitespace-delimited word that GFM's autolink extension could link: it
 * holds an email `@`, a mention `@name`, a URL scheme or `www.`. GFM starts a bare autolink after
 * whitespace or one of `*_~(`, and an email's local part may include dots,
 * slashes and underscores, so the whole word is the unit of protection rather
 * than a pattern for each form. Words never overlap, so no candidate can be
 * dropped or repeated.
 */
const LINKABLE_WORD =
  /@[^\s@]*[^\s@.]\.[^\s@]|(?<![\w@])@\w|:\/\/|www\.|mailto:|xmpp:/i;
const TRAILING_PUNCTUATION = ".,;:!?\"'\u2019\u201D)]}>";

type Autolink = { index: number; value: string };

const LEADING_BOUNDARY = "([{<\"'\u2018\u201C]";

/**
 * The linkable words, each starting after any opening bracket or quote that
 * precedes its first autolink marker: neither can begin a URL or an email's
 * local part, so `![x](https://example.org)` protects only the URL.
 */
const bareAutolinks = (value: string): Autolink[] => {
  const found: Autolink[] = [];
  for (const word of value.matchAll(/\S+/g)) {
    const marker = word[0].search(LINKABLE_WORD);
    if (marker === -1) continue;
    let cut = -1;
    for (let i = 0; i < marker; i++)
      if (LEADING_BOUNDARY.includes(word[0][i] ?? "")) cut = i;
    found.push({
      index: (word.index ?? 0) + cut + 1,
      value: word[0].slice(cut + 1),
    });
  }
  return found;
};

/** Sentence punctuation and closing quotes stay outside the code span. */
const trimAutolinkPunctuation = (value: string) => {
  let end = value.length;
  let open = 0;
  let close = 0;
  for (const ch of value) {
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  while (end > 0) {
    const last = value[end - 1] ?? "";
    if (!TRAILING_PUNCTUATION.includes(last)) break;
    if (last === ")") {
      if (close <= open) break;
      close--;
    }
    end--;
  }
  return end === 0 ? value : value.slice(0, end);
};

/**
 * Source text is literal text, never markup. Bare autolinks need a parsing
 * boundary rather than punctuation escaping: GFM decodes those escapes before
 * its autolink extension runs. Code spans preserve the source spelling and
 * are skipped by that extension. In a table cell the pipes inside a code span
 * are escaped too, since the row splits before inline parsing; pipes in plain
 * text are escaped already.
 */
export const lit = (value: string, inTable = false) => {
  let at = 0;
  let rendered = "";
  for (const match of bareAutolinks(value)) {
    const start = match.index;
    const target = trimAutolinkPunctuation(match.value);
    rendered += markdownText(
      value.slice(at, start),
      at === 0 || value[at - 1] === "\n",
    );
    rendered += code(inTable ? target.replace(/\|/g, "\\|") : target);
    at = start + target.length;
  }
  return (
    rendered + markdownText(value.slice(at), at === 0 || value[at - 1] === "\n")
  );
};
/** Source text inside a table cell: escaped, and on one line. */
export const cell = (value: string) =>
  lit(value, true).replace(/\s*\n\s*/g, " ");
/**
 * A URL inside a link target. Characters that end or escape the destination,
 * or split a table row, are percent-encoded; `&` becomes an entity because
 * Markdown decodes entities in destinations.
 */
export const href = (url: string) =>
  url
    .replace(/&/g, "&amp;")
    .replace(
      /[()<>|`\s]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
/**
 * A citation or a file name, as inline code. The delimiter is longer than
 * any backtick run in the value, and line breaks become spaces: a blank line
 * would end the code span's paragraph and let the rest be read as Markdown or
 * raw HTML.
 */
export const code = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  let longestBacktickRun = 0;
  for (const match of text.matchAll(/`+/g))
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
};
