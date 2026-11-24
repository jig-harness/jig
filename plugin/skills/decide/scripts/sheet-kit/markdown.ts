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

/** Every GFM bare-autolink form, rendered as source text rather than a link. */
const URL_AUTOLINK =
  /\b(?:(?:https?|ftp):\/\/[^\s<>()]+|(?:www\.)[^\s<>()]+|(?:mailto|xmpp):[^\s<>()]+)/gi;
const EMAIL_LOCAL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]/i;
const EMAIL_DOMAIN = /[a-z0-9_-]/i;

type Autolink = { index: number; value: string };

const emailStart = (value: string, at: number) => {
  let start = at;
  while (start > 0 && EMAIL_LOCAL.test(value[start - 1] ?? "")) start--;
  return start;
};

const emailEnd = (value: string, at: number): number | null => {
  let end = at + 1;
  while (end < value.length && EMAIL_DOMAIN.test(value[end] ?? "")) end++;
  if (end === at + 1) return null;
  const suffix = value.slice(end).match(/^(?:\.[a-z0-9_-]+)+/i)?.[0];
  return suffix === undefined ? null : end + suffix.length;
};

/** Find email candidates from their `@`, avoiding a backtracking scan of prose. */
const emailAutolinks = (value: string): Autolink[] => {
  const found: Autolink[] = [];
  for (
    let at = value.indexOf("@");
    at !== -1;
    at = value.indexOf("@", at + 1)
  ) {
    const start = emailStart(value, at);
    const end = emailEnd(value, at);
    if (start < at && end !== null)
      found.push({ index: start, value: value.slice(start, end) });
  }
  return found;
};

const bareAutolinks = (value: string): Autolink[] => {
  const found = [
    ...[...value.matchAll(URL_AUTOLINK)].map((match) => ({
      index: match.index ?? 0,
      value: match[0],
    })),
    ...emailAutolinks(value),
  ];
  const nonOverlapping: Autolink[] = [];
  let acceptedEnd = 0;
  for (const match of found.sort(
    (left, right) =>
      left.index - right.index || right.value.length - left.value.length,
  )) {
    if (match.index < acceptedEnd) continue;
    nonOverlapping.push(match);
    acceptedEnd = match.index + match.value.length;
  }
  return nonOverlapping;
};

const trimAutolinkPunctuation = (value: string) => {
  let end = value.length;
  while (end > 0 && ".,;:!?".includes(value[end - 1] ?? "")) end--;
  return value.slice(0, end);
};

/**
 * Source text is literal text, never markup. Bare autolinks need a parsing
 * boundary rather than punctuation escaping: GFM decodes those escapes before
 * its autolink extension runs. Code spans preserve the source spelling and
 * are skipped by that extension.
 */
export const lit = (value: string) => {
  let at = 0;
  let rendered = "";
  for (const match of bareAutolinks(value)) {
    const start = match.index;
    const target = trimAutolinkPunctuation(match.value);
    rendered += markdownText(
      value.slice(at, start),
      at === 0 || value[at - 1] === "\n",
    );
    rendered += code(target);
    at = start + target.length;
  }
  return (
    rendered + markdownText(value.slice(at), at === 0 || value[at - 1] === "\n")
  );
};
/** Source text inside a table cell: escaped, and on one line. */
export const cell = (value: string) =>
  lit(value)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");
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
