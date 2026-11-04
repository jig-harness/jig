/**
 * Read literal CREATE TABLE declarations from source text. Source escapes are
 * decoded once, with source locations retained; the SQL reader then consumes
 * tokens, treating comments as trivia only between tokens, never inside names.
 * This does not evaluate expressions or assemble SQL from separate strings.
 */
interface Source {
  text: string;
  lines: number[];
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  f: "\f",
  b: "\b",
  "0": "\0",
};

function escapeValue(raw: string): string {
  const code = raw.slice(1);
  if (/^[ux]/i.test(code)) {
    const digits = code.startsWith("u{") ? code.slice(2, -1) : code.slice(1);
    const point = Number.parseInt(digits, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
  }
  if (code === "\n" || code === "\r\n") return "";
  return ESCAPES[code] ?? code;
}

function decoded(source: string): Source {
  const parts: string[] = [];
  const lines: number[] = [];
  let line = 1;
  const sourceEscape =
    /\\(?:u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|[\s\S])/iy;
  for (let at = 0; at < source.length; ) {
    sourceEscape.lastIndex = at;
    const match = sourceEscape.exec(source);
    const raw = match?.[0] ?? (source[at] as string);
    const value = match ? escapeValue(raw) : raw;
    parts.push(value);
    for (let n = 0; n < value.length; n++) lines.push(line);
    line += raw.split("\n").length - 1;
    at += raw.length;
  }
  return { text: parts.join(""), lines };
}

interface Token {
  text: string;
  quoted: boolean;
}

/** A small SQL token reader: trivia, quoted identifiers, words and punctuation. */
class Tokens {
  readonly text: string;
  at: number;

  constructor(text: string, at: number) {
    this.text = text;
    this.at = at;
  }

  next(): Token | null {
    const trivia = /(?:\s+|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*(?:\n|$))*/y;
    trivia.lastIndex = this.at;
    this.at += trivia.exec(this.text)?.[0].length ?? 0;
    const rest = this.text.slice(this.at);
    if (!rest) return null;
    const quote = rest[0] as string;
    if (['"', "'", "`", "["].includes(quote)) return this.quoted(rest, quote);
    const word = /^[A-Za-z_]\w*/.exec(rest)?.[0] ?? quote;
    this.at += word.length;
    return { text: word, quoted: false };
  }

  private quoted(rest: string, quote: string): Token | null {
    const end = quote === "[" ? "]" : quote;
    let value = "";
    for (let n = 1; n < rest.length; n++) {
      const char = rest[n] as string;
      if (char === end) {
        if (quote !== "[" && rest[n + 1] === end) n++;
        else {
          this.at += n + 1;
          return { text: value, quoted: true };
        }
      }
      value += char;
    }
    this.at = this.text.length;
    return null;
  }
}

function is(token: Token | null, word: string): boolean {
  return token !== null && !token.quoted && token.text.toUpperCase() === word;
}

function tableHeader(tokens: Tokens): boolean {
  let token = tokens.next();
  if (["TEMP", "TEMPORARY", "VIRTUAL"].some((word) => is(token, word)))
    token = tokens.next();
  return is(token, "TABLE");
}

function nameToken(tokens: Tokens): Token | null {
  const name = tokens.next();
  if (!is(name, "IF")) return name;
  if (!is(tokens.next(), "NOT") || !is(tokens.next(), "EXISTS")) return null;
  return tokens.next();
}

function literalName(tokens: Tokens): string | null {
  const name = nameToken(tokens);
  if (name === null) return null;
  if (!name.quoted && !/^[A-Za-z_]\w*$/.test(name.text)) return null;
  const end = tokens.next();
  return is(end, "(") || is(end, "AS") || is(end, "USING") ? name.text : null;
}

/** A recognized header always produces either a literal name or a null name. */
export function sqlTables(
  source: string,
): { name: string | null; line: number }[] {
  const sql = decoded(source);
  const found: { name: string | null; line: number }[] = [];
  const creates = /\bCREATE\b/gi;
  for (
    let match = creates.exec(sql.text);
    match;
    match = creates.exec(sql.text)
  ) {
    const tokens = new Tokens(sql.text, creates.lastIndex);
    if (!tableHeader(tokens)) continue;
    found.push({
      name: literalName(tokens),
      line: sql.lines[match.index] ?? 1,
    });
    creates.lastIndex = tokens.at;
  }
  return found;
}
