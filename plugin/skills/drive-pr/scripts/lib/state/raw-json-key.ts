import { swallow } from "../../../../../shared/errors.ts";

/** Index of the closing quote of the literal opened at `open`, or -1 when it never closes. */
function closingQuote(text: string, open: number): number {
  let j = open + 1;
  while (j < text.length && text[j] !== '"') {
    // A backslash skips the character after it. For a `\uXXXX` escape this
    // skips only the `\u`; the hex digits cannot be `"` or `\`, so they scan
    // as plain characters.
    j += text[j] === "\\" ? 2 : 1;
  }
  return j < text.length ? j : -1;
}

function decodeLiteral(literal: string): unknown {
  try {
    return JSON.parse(literal);
  } catch (err) {
    swallow(err, "a string literal that does not decode is not the key");
    return undefined;
  }
}

function followedByColon(text: string, from: number): boolean {
  let k = from;
  while (k < text.length && /\s/.test(text[k] ?? "")) k++;
  return text[k] === ":";
}

/**
 * Does an otherwise-unparseable JSON text still contain a string-literal
 * property KEY that DECODES to `target`, anywhere in the text?
 *
 * A byte-substring check misses an escaped spelling of the same key, so this
 * scans the text as JSON string literals (respecting `\`-escapes) and lets
 * `JSON.parse` decode each candidate; the document need not be valid JSON. Only
 * a literal followed by `:` is a key: a match in value position
 * (`{"reason":"ciHold"}`) would refuse `reset` over corruption that never named
 * the key.
 */
export function rawTextMentionsJsonKey(text: string, target: string): boolean {
  let i = text.indexOf('"');
  while (i !== -1) {
    const j = closingQuote(text, i);
    // An unterminated literal leaves nothing further to scan.
    if (j === -1) return false;
    if (
      decodeLiteral(text.slice(i, j + 1)) === target &&
      followedByColon(text, j + 1)
    )
      return true;
    i = text.indexOf('"', j + 1);
  }
  return false;
}
