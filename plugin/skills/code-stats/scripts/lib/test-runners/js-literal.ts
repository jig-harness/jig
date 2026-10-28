/**
 * The exported configuration of a JavaScript or TypeScript file, read as
 * text and never run: `export default`, `export =` or `module.exports =`
 * of an object literal, of `defineConfig({…})` or `defineProject({…})`, or
 * of a variable declared with one of those. Inside the object, strings
 * (template strings without `${…}`), numbers, `true`, `false`, `null`,
 * arrays and nested objects are read; any other value (a variable, a call,
 * an expression) is kept as `computed` with its text, and a spread or
 * computed key marks the object `open`, since it may supply any key, and
 * drops the entries before it, which it may override.
 *
 * A file that exports a function, the result of another call, an
 * expression that goes on after the object, or a variable it mentions again
 * after declaring it, that sets its export or declares that variable
 * anywhere but as an unconditional statement at the top of the file (inside
 * another expression, a block, a function, or after `if (…)`), or that
 * reaches `module`, `exports` or `this` anywhere else, is refused with an
 * `UnreadableError` naming why: its configuration exists only when it runs.
 * Keywords and names are looked for outside strings, comments and regular
 * expressions, but inside a template string's `${…}`, which runs and is
 * lexed as code, its own strings and templates included.
 */
import { closeAt } from "../count.ts";
import { UnreadableError } from "./model.ts";

/** A value the file computes when it runs, kept as its text. */
export class Computed {
  readonly computed: string;
  constructor(text: string) {
    this.computed = text;
  }
}

export class LiteralObject {
  readonly entries = new Map<string, Literal>();
  /** A spread or computed key: the object may hold keys not listed. */
  open = false;
}
export type Literal =
  | string
  | number
  | boolean
  | null
  | Literal[]
  | LiteralObject
  | Computed;

export const isLiteralObject = (
  value: Literal | undefined,
): value is LiteralObject => value instanceof LiteralObject;

const isComputed = (value: Literal | undefined): value is Computed =>
  value instanceof Computed;

/** A JSON value as a literal object tree. */
export function fromJson(value: unknown): Literal {
  if (Array.isArray(value)) return value.map(fromJson);
  if (typeof value === "object" && value !== null) {
    const obj = new LiteralObject();
    for (const [k, v] of Object.entries(value)) obj.entries.set(k, fromJson(v));
    return obj;
  }
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean" || value === null) return value;
  return new Computed(String(value));
}

const isComment = (part: string) =>
  part.startsWith("//") || part.startsWith("/*");

/** `part` as spaces, its line breaks kept. */
const spaced = (part: string) => part.replace(/[^\n]/g, " ");

/** `text` with each comment, string and regular expression passed through `shown`, positions unchanged. */
function blank(text: string, shown: (part: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const end = spanEnd(text, i);
    if (end === null) {
      out += text[i] as string;
      i++;
      continue;
    }
    out += shown(text.slice(i, end));
    i = end;
  }
  return out;
}

/** `text` with every comment blanked and every string kept, positions unchanged. */
export function withoutComments(text: string): string {
  return blank(text, (part) => (isComment(part) ? spaced(part) : part));
}

/**
 * `text` with every comment, string and regular expression blanked,
 * positions unchanged: what is left is syntax, so a search for a keyword or
 * a name in it never matches the inside of a string. The `${…}`
 * expressions of a template string stay, since they run.
 */
function syntaxOnly(text: string): string {
  return blank(text, (part) =>
    part.startsWith("`") ? templateSyntax(part) : spaced(part),
  );
}

/** A template string with its text blanked and its `${…}` expressions kept. */
function templateSyntax(part: string): string {
  return templateSpan(part, 0).out;
}

/** A lexed stretch of text: its syntax view and the index it ends at. */
interface Span {
  out: string;
  end: number;
  closed: boolean;
}

/**
 * The template string that opens at the backtick at `i`: its text blanked,
 * and each `${…}` expression lexed as code, so a string, comment, regular
 * expression or template inside one is read as what it is.
 */
function templateSpan(text: string, i: number): Span {
  let out = " ";
  let at = i + 1;
  while (at < text.length) {
    const c = text[at] as string;
    if (c === "`") return { out: `${out} `, end: at + 1, closed: true };
    if (c === "\\") {
      out += spaced(text.slice(at, at + 2));
      at += 2;
    } else if (text.startsWith("${", at)) {
      const inner = codeSpan(text, at + 2);
      out += `  ${inner.out}`;
      at = inner.end;
      if (!inner.closed) return { out, end: at, closed: false };
      out += " ";
      at++;
    } else {
      out += spaced(c);
      at++;
    }
  }
  return { out, end: at, closed: false };
}

/**
 * The code of a `${…}` expression from `i`, lexed: its comments, strings
 * and regular expressions blanked, up to the `}` that closes it.
 */
function codeSpan(text: string, i: number): Span {
  let out = "";
  let depth = 0;
  let at = i;
  while (at < text.length) {
    const c = text[at] as string;
    const end = spanEnd(text, at);
    if (end !== null) {
      const part = text.slice(at, end);
      out += part.startsWith("`") ? templateSyntax(part) : spaced(part);
      at = end;
      continue;
    }
    if (c === "}" && depth === 0) return { out, end: at, closed: true };
    if (c === "{") depth++;
    else if (c === "}") depth--;
    out += c;
    at++;
  }
  return { out, end: at, closed: false };
}

/** The end of the comment, string or regular expression that opens at `i`, or null. */
function spanEnd(text: string, i: number): number | null {
  const two = text.slice(i, i + 2);
  const orEnd = (at: number, extra: number) =>
    at === -1 ? text.length : at + extra;
  if (two === "//") return orEnd(text.indexOf("\n", i), 0);
  if (two === "/*") return orEnd(text.indexOf("*/", i + 2), 2);
  const c = text[i] as string;
  if (c === "`") return templateSpan(text, i).end;
  if (c === '"' || c === "'") {
    const end = closeAt(text, i + 1, c);
    return end === -1 ? text.length : end;
  }
  return c === "/" ? regexEnd(text, i) : null;
}

/** The characters after which a `/` opens a regular expression rather than divides. */
const BEFORE_REGEX = "(,=:[!&|?{};";

/**
 * The end of the regular expression literal that opens at `i`, flags
 * included, or null when the `/` there divides: one is a regular
 * expression only where a value may start, and it never spans a line.
 */
function regexEnd(text: string, i: number): number | null {
  return valueMayStart(text, i) ? regexClose(text, i) : null;
}

/** Whether a value may start at `i`: nothing but space since the last operator. */
function valueMayStart(text: string, i: number): boolean {
  let before = i - 1;
  while (before >= 0 && /\s/.test(text[before] as string)) before--;
  return before < 0 || BEFORE_REGEX.includes(text[before] as string);
}

/**
 * The end of the regular expression whose `/` is at `i`, flags included;
 * null when none closes on that line.
 */
function regexClose(text: string, i: number): number | null {
  REGEX_LITERAL.lastIndex = i;
  return REGEX_LITERAL.test(text) ? REGEX_LITERAL.lastIndex : null;
}

/** A regular expression literal: escapes and classes may hold `/`; flags follow. */
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+\/[a-z]*/iy;

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+)/iy;
const CLOSERS = ",)]};";
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

class Reader {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string))
      this.i++;
  }

  peek(): string {
    this.ws();
    return this.s[this.i] ?? "";
  }

  word(): string | null {
    this.ws();
    IDENT.lastIndex = this.i;
    const m = IDENT.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  /** Skip an expression up to a `,`, `;` or closing bracket at this depth. */
  skipExpression(): void {
    const stack: string[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      const end = spanEnd(this.s, this.i);
      if (end !== null) {
        this.i = end;
        continue;
      }
      if (c in OPENERS) stack.push(OPENERS[c] as string);
      else if (stack.length && c === stack[stack.length - 1]) stack.pop();
      else if (!stack.length && CLOSERS.includes(c)) return;
      this.i++;
    }
  }

  /** A value, or `computed` with its text when it is not a literal. */
  value(): Literal {
    const start = this.i;
    const literal = this.literal();
    this.typeSuffix();
    const next = this.peek();
    if (literal !== undefined && (next === "" || CLOSERS.includes(next)))
      return literal;
    this.i = start;
    this.skipExpression();
    return new Computed(this.s.slice(start, this.i).trim());
  }

  /**
   * `as T`, `satisfies T` and `!` after a value: types only. A type is read
   * only when it is named (`const`, `Config`, `vite.UserConfig<X>[]`); one
   * written another way is left at the reader, where it reads as an
   * expression that goes on.
   */
  typeSuffix(): void {
    for (;;) {
      const at = this.i;
      if (this.peek() === "!" && this.s[this.i + 1] !== "=") {
        this.i++;
        continue;
      }
      const w = this.word();
      if ((w === "as" || w === "satisfies") && this.typeName()) continue;
      this.i = at;
      return;
    }
  }

  /** A named type at the reader, consumed: a dotted name, type arguments and `[]`s; false when the type is written another way. */
  typeName(): boolean {
    if (this.word() === null) return false;
    for (;;) {
      const at = this.i;
      const c = this.peek();
      if (c === ".") {
        this.i++;
        if (this.word() === null) return false;
      } else if (c === "<") {
        if (!this.typeArguments()) return false;
      } else if (this.s.startsWith("[]", this.i)) this.i += 2;
      else {
        this.i = at;
        return true;
      }
    }
  }

  /** The `<…>` type arguments at the reader, consumed; false when they never close on a type. */
  typeArguments(): boolean {
    let depth = 0;
    for (let j = this.i; j < this.s.length; j++) {
      const c = this.s[j] as string;
      if (c === "<") depth++;
      else if (c === ">" && this.s[j - 1] !== "=" && --depth === 0) {
        this.i = j + 1;
        return true;
      } else if (c === ";" || c === "\n") return false;
    }
    return false;
  }

  literal(): Literal | undefined {
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "`") return this.template();
    const n = this.number();
    return n === null ? this.constant() : Number(n.replaceAll("_", ""));
  }

  /** A number's text at the cursor, consumed, or null. */
  number(): string | null {
    NUMBER.lastIndex = this.i;
    const n = NUMBER.exec(this.s);
    if (!n) return null;
    this.i += n[0].length;
    return n[0];
  }

  /** `true`, `false`, `null` or `undefined` at the cursor; undefined for anything else. */
  constant(): Literal | undefined {
    const at = this.i;
    const w = this.word();
    if (w === "true" || w === "false") return w === "true";
    if (w === "null" || w === "undefined") return null;
    this.i = at;
    return undefined;
  }

  string(): string {
    const quote = this.s[this.i] as string;
    const end = closeAt(this.s, this.i + 1, quote);
    if (end === -1) throw new UnreadableError("has a string it never closes");
    const body = this.s.slice(this.i + 1, end - 1);
    this.i = end;
    return decodeEscapes(body);
  }

  template(): Literal | undefined {
    const { end, closed } = templateSpan(this.s, this.i);
    if (!closed) throw new UnreadableError("has a string it never closes");
    const body = this.s.slice(this.i + 1, end - 1);
    if (/(^|[^\\])\$\{/.test(body)) return undefined;
    this.i = end;
    return decodeEscapes(body);
  }

  array(): Literal[] {
    this.i++;
    const items: Literal[] = [];
    for (;;) {
      const c = this.peek();
      if (c === "]") {
        this.i++;
        return items;
      }
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "") throw new UnreadableError("has a list it never closes");
      const at = this.i;
      items.push(
        this.s.startsWith("...", this.i) ? this.spread() : this.value(),
      );
      this.advanced(at, c);
    }
  }

  /** Refuse an item that read nothing: `c` stands where a value belongs. */
  advanced(at: number, c: string): void {
    if (this.i === at)
      throw new UnreadableError(
        `has ${JSON.stringify(c)} where a value belongs`,
      );
  }

  spread(): Computed {
    const start = this.i;
    this.skipExpression();
    return new Computed(this.s.slice(start, this.i).trim());
  }

  key(): string | null {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    return this.number() ?? this.word();
  }

  object(): LiteralObject {
    this.i++;
    const obj = new LiteralObject();
    for (;;) {
      const c = this.peek();
      if (c === "}") {
        this.i++;
        return obj;
      }
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "") throw new UnreadableError("has an object it never closes");
      const at = this.i;
      this.entry(obj);
      this.advanced(at, c);
    }
  }

  /**
   * One entry: `key: value`, a shorthand, a method, a spread or a computed
   * key. A spread or computed key may set any key, so the entries before it
   * are no longer certain and are dropped: the object is `open`.
   */
  entry(obj: LiteralObject): void {
    const start = this.i;
    if (this.s.startsWith("...", this.i) || this.peek() === "[") {
      obj.open = true;
      obj.entries.clear();
      this.skipExpression();
      return;
    }
    const key = this.key();
    const next = this.peek();
    if (key !== null && next === ":") {
      this.i++;
      obj.entries.set(key, this.value());
      return;
    }
    this.i = start;
    this.skipExpression();
    const text = this.s.slice(start, this.i).trim();
    if (key !== null && /^[\w$]+$/.test(key))
      obj.entries.set(key, new Computed(text));
    else {
      obj.open = true;
      obj.entries.clear();
    }
  }
}

function decodeEscapes(body: string): string {
  return body.replace(
    /\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\n|.)/gi,
    (_, e: string) => {
      if (/^u\{/i.test(e))
        return String.fromCodePoint(Number.parseInt(e.slice(2, -1), 16));
      if (/^[ux]/i.test(e) && e.length > 1)
        return String.fromCharCode(Number.parseInt(e.slice(1), 16));
      if (e === "\n") return "";
      return ESCAPES[e] ?? e;
    },
  );
}

const DEFINE = new Set(["defineConfig", "defineProject"]);
const EXPORT =
  /\bexport\s+default\s+|\bexport\s*=\s*|\bmodule\.exports\s*=\s*/g;

/** A file's code, comments blanked, beside its syntax alone (strings blanked too), at the same positions. */
interface Source {
  code: string;
  syntax: string;
}

/**
 * A name through which a CommonJS file reaches its exports, outside the one
 * `module.exports =` that sets them: `module` (`module['exports']`, an alias,
 * an argument), `exports`, or `this`, which is `module.exports` at the top
 * of the file. A key of that name (`{ module: … }`) reaches nothing.
 */
const REACHES_EXPORTS = /(?<![\w$.])(?:module|exports|this)(?![\w$])(?!\s*:)/;

/** Words a statement cannot end with: what follows them is part of them, or runs only on a condition. */
const OPENING_WORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Whether what starts at `at` is an unconditional statement at the top of
 * the file: outside every bracket (a function, a block, a call), and where a
 * statement starts — at the start of the file, after a `;` or a `}`, or on
 * a new line after a value that ends the statement before. A `)` before it
 * may close `if (…)`, `while (…)` or `for (…)`, so it does not count; nor
 * does an operator, which makes it an operand (`c = module.exports = …`).
 */
function topLevelStatement(src: Source, at: number): boolean {
  if (bracketDepth(src.syntax, at) !== 0) return false;
  const before = src.code.slice(0, at).trimEnd();
  // `export const c = …` is the statement `export` starts.
  const exported = /(?<![\w$.])export$/.exec(before);
  if (exported) return topLevelStatement(src, exported.index);
  const last = before[before.length - 1];
  if (last === undefined || last === ";" || last === "}") return true;
  return (
    src.code.slice(before.length, at).includes("\n") && endsStatement(before)
  );
}

/** How many brackets are open in `syntax` at `at`. */
function bracketDepth(syntax: string, at: number): number {
  let depth = 0;
  for (const c of syntax.slice(0, at)) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return depth;
}

/** Whether `before` ends with a value that ends a statement at a line break: a name that is no keyword, a string or a `]`. */
function endsStatement(before: string): boolean {
  const word = /[\w$]+$/.exec(before)?.[0];
  if (word !== undefined) return !OPENING_WORDS.has(word);
  return /["'`\]]$/.test(before);
}

/**
 * The configuration object `text` exports; an `UnreadableError` says why
 * there is none to read.
 */
export function exportedObject(text: string): LiteralObject {
  const src: Source = { code: withoutComments(text), syntax: syntaxOnly(text) };
  const exports = [...src.syntax.matchAll(EXPORT)];
  const last = exports[exports.length - 1];
  if (!last)
    throw new UnreadableError(
      "has no export default or module.exports to read",
    );
  const assigned = src.syntax.match(/\bmodule\.exports\s*=/g)?.length ?? 0;
  if (assigned > 1 || REACHES_EXPORTS.test(src.syntax.replace(EXPORT, " ")))
    throw new UnreadableError(
      "changes module.exports after setting it, so its configuration exists only when it runs",
    );
  if (!topLevelStatement(src, last.index as number))
    throw new UnreadableError(
      "sets its export inside another expression, block or function, or behind a condition, so its configuration may change when it runs",
    );
  return expression(src, (last.index as number) + last[0].length, 0);
}

/** The object the expression at `at` stands for. */
function expression(src: Source, at: number, depth: number): LiteralObject {
  const r = new Reader(src.code);
  r.i = at;
  const c = r.peek();
  if (c === "{") return ended(r, r.object());
  const name = r.word();
  if (name === "async" || name === "function" || c === "(")
    throw new UnreadableError(
      "exports a function, so its configuration exists only when it runs",
    );
  if (name === null)
    throw new UnreadableError("exports something other than an object");
  const after = r.i;
  if (r.peek() === "(") return defined(r, src, name, depth);
  r.i = after;
  ended(r, null);
  return variable(src, name, depth);
}

/**
 * `value`, once the expression it was read from has ended at the reader:
 * nothing but types, a `;` or the next statement follows. Anything else
 * (`&& makeConfig()`, `.extend(…)`) computes the export from it.
 */
function ended<T>(r: Reader, value: T): T {
  r.typeSuffix();
  const from = r.i;
  const next = r.peek();
  if (next === "" || next === ";") return value;
  if (r.s.slice(from, r.i).includes("\n") && /[\w$@'"]/.test(next))
    return value;
  throw new UnreadableError(
    `exports an expression that goes on after the object (${JSON.stringify(next)}), computed when it runs`,
  );
}

/** The `)` closing a call's single argument at the reader, consumed. */
function closeCall(r: Reader, name: string): void {
  if (r.peek() === ",") r.i++;
  if (r.peek() !== ")")
    throw new UnreadableError(
      `passes ${name} more than one argument, computed when it runs`,
    );
  r.i++;
}

/** The object passed to `defineConfig(…)` or `defineProject(…)` at the reader's `(`. */
function defined(
  r: Reader,
  src: Source,
  name: string,
  depth: number,
): LiteralObject {
  if (!DEFINE.has(name))
    throw new UnreadableError(
      `exports the result of ${name}(…), computed when it runs`,
    );
  r.i++;
  if (r.peek() === "{") {
    const obj = r.object();
    closeCall(r, name);
    return ended(r, obj);
  }
  const inner = r.word();
  if (inner === null || inner === "async" || inner === "function")
    throw new UnreadableError(
      `passes a function to ${name}, so its configuration exists only when it runs`,
    );
  closeCall(r, name);
  ended(r, null);
  return variable(src, inner, depth);
}

/**
 * The object a variable is declared as. The file may name it only where it
 * declares it and where it exports it: any other mention (a change, a
 * reassignment, an alias) may give it another value when the file runs.
 */
function variable(src: Source, name: string, depth: number): LiteralObject {
  if (depth > 2)
    throw new UnreadableError(`exports ${name}, declared through other names`);
  const id = name.replaceAll("$", "\\$");
  const declaration = new RegExp(
    `(?:^|[^\\w$])(?:const|let|var)\\s+${id}(?![\\w$])[^=;]*?=(?![=>])`,
  ).exec(src.syntax);
  if (!declaration)
    throw new UnreadableError(
      `exports ${name}, which it does not declare as an object`,
    );
  const keyword =
    (declaration.index as number) + declaration[0].search(/const|let|var/);
  if (!topLevelStatement(src, keyword))
    throw new UnreadableError(
      `declares ${name} inside a block or function, or behind a condition, so its configuration may change when it runs`,
    );
  const mentions = src.syntax.match(
    new RegExp(`(?<![\\w$.])${id}(?![\\w$])`, "g"),
  );
  if ((mentions?.length ?? 0) > 2)
    throw new UnreadableError(
      `uses ${name} again after declaring it, so its configuration may change when it runs`,
    );
  const after = (declaration.index as number) + declaration[0].length;
  return expression(src, after, depth + 1);
}

/**
 * The value at `keys` inside `obj`: the literal, `undefined` when it is
 * certainly absent, or an `UnreadableError` when an open object or a
 * computed value hides it.
 */
export function valueAt(
  obj: LiteralObject,
  keys: readonly string[],
): Literal | undefined {
  let node: Literal | undefined = obj;
  for (const [n, key] of keys.entries()) {
    const path = keys.slice(0, n + 1).join(".");
    if (isComputed(node))
      throw new UnreadableError(`${path} is computed (${node.computed})`);
    if (!isLiteralObject(node)) return undefined;
    const next = node.entries.get(key);
    if (next === undefined && node.open)
      throw new UnreadableError(
        `${path} may come from a spread or computed key`,
      );
    node = next;
  }
  if (isComputed(node))
    throw new UnreadableError(
      `${keys.join(".")} is computed (${node.computed})`,
    );
  return node;
}

/**
 * A key's value as a list of strings: a lone string is a list of one,
 * absent is null. `spreads` resolves a known spread (`...configDefaults.exclude`)
 * to the list it stands for; any other non-string is refused.
 */
export function stringsAt(
  obj: LiteralObject,
  keys: readonly string[],
  spreads: Readonly<Record<string, readonly string[]>> = {},
): string[] | null {
  const value = valueAt(obj, keys);
  if (value === undefined || value === null) return null;
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "string") return [item];
    const known = isComputed(item)
      ? spreads[item.computed.replace(/^\.\.\.\s*/, "")]
      : undefined;
    if (known) return [...known];
    throw new UnreadableError(
      `${keys.join(".")} holds a value that is not a string${isComputed(item) ? ` (${item.computed})` : ""}`,
    );
  });
}

/** A key's value as one string, or null when absent. */
export function stringAt(
  obj: LiteralObject,
  keys: readonly string[],
): string | null {
  const value = valueAt(obj, keys);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new UnreadableError(`${keys.join(".")} is not a string`);
  return value;
}
