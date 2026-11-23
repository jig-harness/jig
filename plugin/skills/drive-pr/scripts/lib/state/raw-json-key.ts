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
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        // Skip the backslash and the character immediately after it. For a
        // `\uXXXX` escape this skips only the `\u`, leaving the four hex
        // digits to be scanned normally on subsequent iterations — none of
        // which can themselves be `"` or `\`, so they safely fall through
        // to the plain-character path below without special-casing the
        // escape's length.
        j += 2;
        continue;
      }
      if (text[j] === '"') break;
      j++;
    }
    if (j >= text.length) {
      // Unterminated string literal — nothing further to scan.
      break;
    }
    const literal = text.slice(i, j + 1);
    let decoded: unknown;
    try {
      decoded = JSON.parse(literal);
    } catch {
      // Not actually a valid string literal despite the scan above (should
      // not happen for well-formed escape sequences) — skip and continue.
      decoded = undefined;
    }
    if (decoded === target) {
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k] ?? "")) k++;
      if (text[k] === ":") return true;
    }
    i = j + 1;
  }
  return false;
}
