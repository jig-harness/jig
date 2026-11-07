/**
 * Read CREATE TABLE declarations inside source string literals. Cooked escapes
 * are decoded once and String.raw templates retain their escapes, with source
 * locations preserved. SQL comments and quoted values cannot start declarations.
 * This does not evaluate expressions or assemble SQL from separate strings.
 */
import { sourceLiterals, type SqlSource } from "./records-source.ts";

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
  return sourceLiterals(source).flatMap(tablesIn);
}

function tablesIn(sql: SqlSource): { name: string | null; line: number }[] {
  const found: { name: string | null; line: number }[] = [];
  const tokens = new Tokens(sql.text, 0);
  for (let token = tokens.next(); token; token = tokens.next()) {
    const start = tokens.at - token.text.length;
    if (!is(token, "CREATE")) continue;
    const header = new Tokens(sql.text, tokens.at);
    if (!tableHeader(header)) continue;
    found.push({
      name: sql.uncertain ? null : literalName(header),
      line: sql.lines[start] ?? 1,
    });
  }
  return found;
}
