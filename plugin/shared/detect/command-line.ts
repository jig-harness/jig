/**
 * A shell command line read as words: split on `&&`, `||`, `;` and `|`
 * outside quotes, the words of each command, and the syntax beyond plain
 * words, quotes and separators that this reading does not parse. The detector
 * reads the commands CI runs with it, and a skill judging a configured
 * command reads that command the same way.
 */

/** A word, or a separator between commands. */
type Token = { word: string } | { separator: string };

/**
 * One piece of a command line: blanks, a separator (`&&`, `||`, `;`, `|`), a
 * single- or double-quoted run (its closing quote captured, empty when
 * missing), or unquoted text. Adjacent pieces other than blanks and
 * separators join into one word.
 */
const PIECE = /(\s+)|(&&|\|\||;|\|)|'([^']*)('?)|"([^"]*)("?)|([^\s;|'"&]+|&)/g;

/**
 * Unquoted text a shell takes literally. Anything else may be expanded,
 * globbed, redirected or grouped, and splitting on blanks and separators
 * alone cannot say what such a line runs.
 */
const PLAIN = /^[\p{L}\p{N}_./:=@%+,#^-]+$/u;

/**
 * Syntax in unquoted or double-quoted text that changes how the rest of a
 * line's quotes and separators are read: an escape, a backtick, or a `$` that
 * opens a span which may hold quotes, blanks and separators (`${…}`, `$(…)`,
 * `$((…))`, `$[…]`, and unquoted `$'…'`, where a backslash escapes the closing
 * quote). Any other `$` is a parameter or a literal `$`, and single-quoted
 * text holds no syntax at all.
 */
const REQUOTES = /[\\`]|\$[{([]/;

/** Whether one piece of a command line, followed by `next`, holds {@link REQUOTES} syntax. */
function requotes(
  blank: string | undefined,
  double: string | undefined,
  text: string | undefined,
  next: string,
): boolean {
  if (blank !== undefined) return /[\r\n]/.test(blank);
  if (double !== undefined) return REQUOTES.test(double);
  if (text === undefined) return false;
  return REQUOTES.test(text) || (text.endsWith("$") && next === "'");
}

/** The words and separators of a command line, and an unclosed quote if any. */
function tokenize(command: string): {
  tokens: Token[];
  unclosed: string | null;
} {
  const tokens: Token[] = [];
  let unclosed: string | null = null;
  let word = "";
  const endWord = () => {
    if (word !== "") tokens.push({ word });
    word = "";
  };
  for (const [
    ,
    blank,
    separator,
    single,
    singleEnd,
    double,
    doubleEnd,
    text,
  ] of command.matchAll(PIECE)) {
    if (blank !== undefined || separator !== undefined) endWord();
    if (separator !== undefined) tokens.push({ separator });
    if (singleEnd === "") unclosed ??= "'";
    if (doubleEnd === "") unclosed ??= '"';
    word += single ?? double ?? text ?? "";
  }
  endWord();
  return { tokens, unclosed };
}

/** Shell syntax in one piece of a command line that this scan does not parse. */
function unsupportedPiece(
  text: string | undefined,
  double: string | undefined,
  wordStart: boolean,
): string | null {
  if (double !== undefined)
    return /[$`]/.test(double) ? `an expansion inside "${double}"` : null;
  if (text === undefined) return null;
  if (wordStart && text.startsWith("#")) return "a comment";
  if (text === "&") return "a background `&`";
  return PLAIN.test(text) ? null : `\`${text}\``;
}

/**
 * Each piece of a command line's shell syntax beyond plain words, quotes and
 * separators, and whether any piece changes how the rest of the line's quotes
 * are read. The pieces are read in order, so every piece before the first
 * such syntax is read as a shell reads it, quoted or not.
 */
function unsupportedPieces(command: string): {
  found: string[];
  requoted: boolean;
} {
  const found: string[] = [];
  let requoted = false;
  let wordStart = true;
  for (const match of command.matchAll(PIECE)) {
    const [whole, blank, separator, , , double, , text] = match;
    const piece = unsupportedPiece(text, double, wordStart);
    if (piece !== null) found.push(piece);
    const next = command.charAt(match.index + whole.length);
    requoted ||= piece === "a comment" || requotes(blank, double, text, next);
    wordStart = blank !== undefined || separator !== undefined;
  }
  return { found, requoted };
}

/**
 * The first shell syntax beyond plain words, quotes and separators, if any,
 * and whether the line's syntax changes how its quotes are read.
 */
function unsupportedSyntax(
  command: string,
): Pick<Scan, "unsupported" | "requoted"> {
  const { found: pieces, requoted } = unsupportedPieces(command);
  if (/[\r\n]/.test(command)) return { unsupported: "a line break", requoted };
  if (command.includes("\\"))
    return { unsupported: "a backslash escape", requoted };
  return { unsupported: pieces[0] ?? null, requoted };
}

/**
 * A command line split into segments of words, why a shell would refuse it,
 * the syntax it uses that this scan does not parse, and whether that syntax
 * changes how its quotes are read (which makes `syntax` a guess too).
 */
interface Scan {
  segments: string[][];
  syntax: string | null;
  unsupported: string | null;
  requoted: boolean;
}

/** Split a command line on `&&`, `||`, `;` and `|` outside quotes, then into words. */
export function scan(command: string): Scan {
  const { tokens, unclosed } = tokenize(command);
  const segments: string[][] = [];
  let syntax: string | null =
    unclosed === null ? null : `has an unclosed ${unclosed} quote`;
  let words: string[] = [];
  for (const token of tokens) {
    if ("word" in token) words.push(token.word);
    else if (words.length > 0) segments.push(words);
    else if (token.separator !== ";")
      syntax ??= `has \`${token.separator}\` with no command before it`;
    if ("separator" in token) words = [];
  }
  if (words.length > 0) segments.push(words);
  const last = tokens.at(-1);
  if (last !== undefined && "separator" in last && last.separator !== ";")
    syntax ??= `ends with \`${last.separator}\` and no command after it`;
  if (segments.length === 0) syntax ??= "runs no command";
  return { segments, syntax, ...unsupportedSyntax(command) };
}

/** Split a command line on `&&`, `||`, `;` and `|` outside quotes, then into words. */
export function commandSegments(command: string): string[][] {
  return scan(command).segments;
}

/** A leading `NAME=value` word: an environment assignment before the command. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop leading `NAME=value` words. */
export function withoutAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
  return words.slice(i);
}

/**
 * The words that run, without leading assignments or an `env` or `exec`
 * prefix; the prefix and its option instead when it takes one, since an
 * option may take a value and what it runs is then unknown here.
 */
export function commandWords(segment: string[]): string[] | string {
  const words = withoutAssignments(segment);
  if (words[0] !== "env" && words[0] !== "exec") return words;
  if (words[1]?.startsWith("-")) return `${words[0]} ${words[1]}`;
  return commandWords(words.slice(1));
}

/** A command line up to its first comment: a shell runs nothing after it. */
export function beforeComment(line: string): string {
  let wordStart = true;
  for (const match of line.matchAll(PIECE)) {
    const [, blank, separator, , , , , text] = match;
    if (wordStart && text?.startsWith("#")) return line.slice(0, match.index);
    wordStart = blank !== undefined || separator !== undefined;
  }
  return line;
}
