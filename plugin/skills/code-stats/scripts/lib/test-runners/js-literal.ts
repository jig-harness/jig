/**
 * The exported configuration of a JavaScript or TypeScript file, read as
 * text and never run: `export default`, `export =` or `module.exports =`
 * of an object literal, of `defineConfig({…})` or `defineProject({…})`, or
 * of a variable declared with one of those. Inside the object, strings
 * (template strings without `${…}`), numbers, `true`, `false`, `null`,
 * arrays and nested objects are read; any other value (a variable, a call,
 * an expression) is kept as `computed` with its text, and a spread or
 * computed key marks the object `open`, since it may supply any key.
 *
 * A file that exports a function, the result of another call, or a
 * variable it changes after declaring it is refused with an
 * `UnreadableError` naming why: its configuration exists only when it runs.
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

/** `text` with every comment blanked and every string kept, positions unchanged. */
export function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const end = spanEnd(text, i);
    if (end === null) {
      out += c;
      i++;
      continue;
    }
    const part = text.slice(i, end);
    out += c === "/" ? part.replace(/[^\n]/g, " ") : part;
    i = end;
  }
  return out;
}

/** The end of the comment or string that opens at `i`, or null. */
function spanEnd(text: string, i: number): number | null {
  const two = text.slice(i, i + 2);
  const orEnd = (at: number, extra: number) =>
    at === -1 ? text.length : at + extra;
  if (two === "//") return orEnd(text.indexOf("\n", i), 0);
  if (two === "/*") return orEnd(text.indexOf("*/", i + 2), 2);
  const c = text[i] as string;
  if (c === '"' || c === "'" || c === "`") {
    const end = closeAt(text, i + 1, c);
    return end === -1 ? text.length : end;
  }
  return null;
}

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

  /** `as T`, `satisfies T` and `!` after a value: types only. */
  typeSuffix(): void {
    for (;;) {
      const at = this.i;
      if (this.peek() === "!" && this.s[this.i + 1] !== "=") {
        this.i++;
        continue;
      }
      const w = this.word();
      if (w === "as" || w === "satisfies") {
        this.skipExpression();
        continue;
      }
      this.i = at;
      return;
    }
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
    const end = closeAt(this.s, this.i + 1, "`");
    if (end === -1) throw new UnreadableError("has a string it never closes");
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
      items.push(
        this.s.startsWith("...", this.i) ? this.spread() : this.value(),
      );
    }
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
      this.entry(obj);
    }
  }

  /** One entry: `key: value`, a shorthand, a method, a spread or a computed key. */
  entry(obj: LiteralObject): void {
    const start = this.i;
    if (this.s.startsWith("...", this.i) || this.peek() === "[") {
      obj.open = true;
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
    else obj.open = true;
  }
}

function decodeEscapes(body: string): string {
  return body.replace(
    /\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\n|.)/gi,
    (_, e: string) => {
      if (/^u\{/i.test(e))
        return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
      if (/^[ux]/i.test(e) && e.length > 1)
        return String.fromCharCode(parseInt(e.slice(1), 16));
      if (e === "\n") return "";
      return ESCAPES[e] ?? e;
    },
  );
}

const DEFINE = new Set(["defineConfig", "defineProject"]);
const EXPORT =
  /\bexport\s+default\s+|\bexport\s*=\s*|\bmodule\.exports\s*=\s*/g;

/**
 * The configuration object `text` exports; an `UnreadableError` says why
 * there is none to read.
 */
export function exportedObject(text: string): LiteralObject {
  const code = withoutComments(text);
  const exports = [...code.matchAll(EXPORT)];
  const last = exports[exports.length - 1];
  if (!last)
    throw new UnreadableError(
      "has no export default or module.exports to read",
    );
  return expression(code, (last.index as number) + last[0].length, 0);
}

/** The object the expression at `at` stands for. */
function expression(code: string, at: number, depth: number): LiteralObject {
  const r = new Reader(code);
  r.i = at;
  const c = r.peek();
  if (c === "{") return r.object();
  const name = r.word();
  if (name === "async" || name === "function" || c === "(")
    throw new UnreadableError(
      "exports a function, so its configuration exists only when it runs",
    );
  if (name === null)
    throw new UnreadableError("exports something other than an object");
  return r.peek() === "("
    ? defined(r, name, depth)
    : variable(code, name, depth);
}

/** The object passed to `defineConfig(…)` or `defineProject(…)` at the reader's `(`. */
function defined(r: Reader, name: string, depth: number): LiteralObject {
  if (!DEFINE.has(name))
    throw new UnreadableError(
      `exports the result of ${name}(…), computed when it runs`,
    );
  r.i++;
  if (r.peek() === "{") return r.object();
  const inner = r.word();
  if (inner === null || inner === "async" || inner === "function")
    throw new UnreadableError(
      `passes a function to ${name}, so its configuration exists only when it runs`,
    );
  return variable(r.s, inner, depth);
}

/** The object a variable is declared as, unless the file changes it later. */
function variable(code: string, name: string, depth: number): LiteralObject {
  if (depth > 2)
    throw new UnreadableError(`exports ${name}, declared through other names`);
  const id = name.replaceAll("$", "\\$");
  const declaration = new RegExp(
    `(?:^|[^\\w$])(?:const|let|var)\\s+${id}(?![\\w$])[^=;]*?=(?![=>])`,
  ).exec(code);
  if (!declaration)
    throw new UnreadableError(
      `exports ${name}, which it does not declare as an object`,
    );
  const after = (declaration.index as number) + declaration[0].length;
  const changed = new RegExp(`(?:^|[^\\w$.])${id}\\s*(?:\\.|\\[)`);
  if (changed.test(code.slice(after)))
    throw new UnreadableError(
      `changes ${name} after declaring it, so its configuration exists only when it runs`,
    );
  return expression(code, after, depth + 1);
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
