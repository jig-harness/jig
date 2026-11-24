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
const markdownText = (value: string) =>
  value
    .replace(/^[ \t]+/gm, "")
    .replace(/[\\`*_[\]<>&|#~]/g, "\\$&")
    .replace(/^([-+=])/gm, "\\$1")
    .replace(/^(\d{1,9})([.)])/gm, "$1\\$2");

/** Every GFM bare-autolink form, rendered as source text rather than a link. */
const BARE_AUTOLINK =
  /\b(?:(?:https?|ftp):\/\/[^\s<>()]+|(?:www\.)[^\s<>()]+|(?:mailto|xmpp):[^\s<>()]+|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/**
 * Source text is literal text, never markup. Bare autolinks need a parsing
 * boundary rather than punctuation escaping: GFM decodes those escapes before
 * its autolink extension runs. Code spans preserve the source spelling and
 * are skipped by that extension.
 */
export const lit = (value: string) => {
  let at = 0;
  let rendered = "";
  for (const match of value.matchAll(BARE_AUTOLINK)) {
    const start = match.index ?? 0;
    const target = match[0].replace(/[.,;:!?]+$/, "");
    rendered += markdownText(value.slice(at, start));
    rendered += code(target);
    at = start + target.length;
  }
  return rendered + markdownText(value.slice(at));
};
/** Source text inside a table cell: escaped, and on one line. */
export const cell = (value: string) => lit(value).replace(/\s*\n\s*/g, " ");
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
 * A citation or a file name, as inline code. A backtick inside becomes a
 * quote, and line breaks become spaces: a blank line would end the code span's
 * paragraph and let the rest be read as Markdown or raw HTML.
 */
export const code = (value: string) =>
  `\`${value.replace(/`/g, "'").replace(/\s+/g, " ").trim()}\``;
