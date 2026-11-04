/** Literal text and the original source line for each character. */
export interface SqlSource {
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
  if (/^[ux]/.test(code)) {
    const digits = code.startsWith("u{") ? code.slice(2, -1) : code.slice(1);
    const point = Number.parseInt(digits, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
  }
  if (code === "\n" || code === "\r\n" || code === "\r") return "";
  return ESCAPES[code] ?? code;
}

/** Read source literals separately from surrounding code and comments. */
class Literals {
  private at = 0;
  private line = 1;
  readonly found: SqlSource[] = [];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private take(raw: string): void {
    this.at += raw.length;
    this.line += raw.split("\n").length - 1;
  }

  private trivia(): boolean {
    const match = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.exec(
      this.source.slice(this.at),
    );
    if (!match) return false;
    this.take(match[0]);
    return true;
  }

  /** Interpolations return at their balanced closing brace; nested literals remain visible. */
  code(interpolation = false): void {
    let depth = 0;
    const recent: string[] = [];
    while (this.at < this.source.length) {
      if (this.trivia()) continue;
      const char = this.source[this.at] as string;
      if (interpolation && char === "}" && depth === 0) {
        this.take(char);
        return;
      }
      const word = this.token(recent);
      if (word === "{") depth++;
      if (word === "}") depth--;
      recent.push(word);
    }
  }

  private token(recent: string[]): string {
    const char = this.source[this.at] as string;
    if (['"', "'", "`"].includes(char)) {
      this.literal(char, recent.slice(-3).join("") === "String.raw");
      return "literal";
    }
    if (char === "/" && this.regex(recent.at(-1) ?? "")) return "literal";
    const word =
      /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.at))?.[0] ?? char;
    this.take(word);
    return word;
  }

  private regex(previous: string): boolean {
    if (
      previous &&
      !/^(?:[=(:,;!&|?{}[]|return|throw|yield|case|void|typeof|delete|in|of)$/.test(
        previous,
      )
    )
      return false;
    const match =
      /^\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/.exec(
        this.source.slice(this.at),
      );
    if (!match) return false;
    this.take(match[0]);
    return true;
  }

  private literal(quote: string, rawTemplate: boolean): void {
    this.take(quote);
    const sql: SqlSource = { text: "", lines: [] };
    while (this.at < this.source.length) {
      const rest = this.source.slice(this.at);
      if (rest.startsWith(quote)) {
        this.take(quote);
        break;
      }
      if (quote === "`" && rest.startsWith("${")) {
        this.append(sql, "\0");
        this.take("${");
        this.code(true);
        continue;
      }
      const sourceEscape =
        /^\\(?:u\{[\dA-Fa-f]+\}|u[\dA-Fa-f]{4}|x[\dA-Fa-f]{2}|\r\n|[\s\S])/.exec(
          rest,
        )?.[0];
      const raw = sourceEscape ?? (rest[0] as string);
      this.append(sql, sourceEscape && !rawTemplate ? escapeValue(raw) : raw);
      this.take(raw);
    }
    this.found.push(sql);
  }

  private append(sql: SqlSource, value: string): void {
    sql.text += value;
    for (let n = 0; n < value.length; n++) sql.lines.push(this.line);
  }
}

export function sourceLiterals(source: string): SqlSource[] {
  const reader = new Literals(source);
  reader.code();
  return reader.found;
}
