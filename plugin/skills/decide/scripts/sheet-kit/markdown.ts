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
export const lit = (value: string) =>
  value
    .replace(/^[ \t]+/gm, "")
    .replace(/[\\`*_[\]<>&|#~]/g, "\\$&")
    .replace(/^([-+=])/gm, "\\$1")
    .replace(/^(\d{1,9})([.)])/gm, "$1\\$2");
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
