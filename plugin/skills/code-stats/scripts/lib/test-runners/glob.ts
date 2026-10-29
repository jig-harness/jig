/**
 * The glob dialect test runners write (jest's micromatch, vitest's
 * tinyglobby, pytest's fnmatch), as a regular expression over a repository
 * path: `**` as a whole segment for any number of folders, `*` and `?`
 * within one, `[...]` classes (`[!...]` or `[^...]` negated), `{a,b}`
 * alternatives, and the extended forms `?(a|b)`, `*(…)`, `+(…)` and `@(…)`
 * that the runners' own defaults use. A negated extended form `!(…)` and a
 * numeric range `{1..3}` are refused: a reader reports the file unreadable
 * rather than read the pattern some other way.
 */
import { UnreadableError } from "./model.ts";

/** Every character a regular expression reads as an operator. */
const SPECIAL = /[.*+?^$|\\()[\]{}/]/;
const EXTENDED: Record<string, (body: string) => string> = {
  "?": (b) => `(?:${b})?`,
  "*": (b) => `(?:${b})*`,
  "+": (b) => `(?:${b})+`,
  "@": (b) => `(?:${b})`,
};

class Parser {
  i = 0;
  readonly p: string;
  constructor(p: string) {
    this.p = p;
  }

  refuse(why: string): never {
    throw new UnreadableError(`the pattern ${JSON.stringify(this.p)} ${why}`);
  }

  /** A sequence up to one of `stops` (at this nesting) or the end. */
  sequence(stops: string): string {
    let out = "";
    while (this.i < this.p.length && !stops.includes(this.p[this.i] as string))
      out += this.atom();
    return out;
  }

  /** Alternatives separated by `sep`, closed by `close`. */
  alternatives(sep: string, close: string): string[] {
    const parts: string[] = [];
    for (;;) {
      parts.push(this.sequence(sep + close));
      const c = this.p[this.i++];
      if (c === close) return parts;
      if (c !== sep)
        this.refuse(`never closes its ${close === ")" ? "(" : "{"}`);
    }
  }

  atom(): string {
    const c = this.p[this.i] as string;
    if (this.p[this.i + 1] === "(" && (c in EXTENDED || c === "!"))
      return this.extended(c);
    this.i++;
    const special = this.special(c);
    return special ?? literal(c);
  }

  /** `?(…)`, `*(…)`, `+(…)` or `@(…)`; `!(…)` is refused. */
  extended(c: string): string {
    if (c === "!") this.refuse("uses !(…), which is not read");
    this.i += 2;
    return (EXTENDED[c] as (b: string) => string)(
      this.alternatives("|", ")").join("|"),
    );
  }

  /** What a glob character after `i` stands for, or null for a plain one. */
  special(c: string): string | null {
    if (c === "*") return this.star();
    if (c === "?") return "[^/]";
    if (c === "[") return this.charClass();
    if (c === "{") return this.braces();
    if (c !== "\\") return null;
    const next = this.p[this.i++];
    if (next === undefined) this.refuse("ends with a lone backslash");
    return literal(next);
  }

  /** `*`, or `**` standing as a whole segment: any number of folders. */
  star(): string {
    const p = this.p;
    const start = this.i - 1;
    while (p[this.i] === "*") this.i++;
    const whole =
      this.i - start > 1 &&
      (start === 0 || p[start - 1] === "/") &&
      (this.i === p.length || p[this.i] === "/");
    if (!whole) return "[^/]*";
    if (p[this.i] === "/") {
      this.i++;
      return "(?:[^/]*/)*";
    }
    return ".*";
  }

  charClass(): string {
    const end = this.p.indexOf("]", this.i + 1);
    if (end === -1) this.refuse("never closes its [");
    let body = this.p.slice(this.i, end);
    this.i = end + 1;
    const negated = /^[!^]/.test(body);
    if (negated) body = body.slice(1);
    body = body.replace(/\\(?!\])/g, "\\\\").replace(/\//g, "");
    return negated ? `[^${body}/]` : `[${body}]`;
  }

  braces(): string {
    const start = this.i;
    const parts = this.alternatives(",", "}");
    const raw = this.p.slice(start, this.i - 1);
    if (parts.length === 1 && /^-?\w+\.\.-?\w+(\.\.\d+)?$/.test(raw))
      this.refuse("uses a {a..b} range, which is not read");
    return `(?:${parts.join("|")})`;
  }
}

/** `c` as a regular expression matching it alone. */
function literal(c: string): string {
  return SPECIAL.test(c) ? `\\${c}` : c;
}

/** The regular expression a glob stands for, over a whole path. */
export function globRegExp(pattern: string): RegExp {
  const parser = new Parser(pattern.replace(/^(\.\/)+/, ""));
  const body = parser.sequence("");
  try {
    return new RegExp(`^${body}$`);
  } catch {
    return parser.refuse("is not a pattern a regular expression can stand for");
  }
}

/** A matcher for `pattern`; an `UnreadableError` when the pattern cannot be read. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const re = globRegExp(pattern);
  return (path) => re.test(path);
}

/** Join a repository folder and a glob relative to it. */
export function globUnder(folder: string, pattern: string): string {
  const relative = pattern.replace(/^(\.\/)+/, "");
  return folder === "" ? relative : `${folder}/${relative}`;
}
