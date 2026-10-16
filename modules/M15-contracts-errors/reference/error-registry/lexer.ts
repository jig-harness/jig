// A small lexer for JavaScript and TypeScript source, enough to tell code
// from what only looks like code: comments, string literals, the text of a
// template literal and regular expression literals. The code inside a
// template literal's `${...}` is code, at any depth of nesting.
//
// A `/` is a regular expression when the token before it cannot end an
// operand: an operator, an opening bracket, the start of the text, or a
// keyword such as `return` or `typeof`, or the `)` that closes the head of
// an `if`, `while`, `for` (`for await` too) or `with`, after which a
// statement begins. After an identifier, a number, a property name (a word
// after a single `.`, keyword or not), any other `)`, a `]`, a literal or a
// postfix `++`/`--` it divides. After `<` it closes a JSX tag. Each of these
// is read from the significant tokens alone: a comment between two tokens
// changes nothing. After a
// `}` that ends a block it could be either, so the lexer throws rather than
// guess; it throws as well on a regular expression, block comment or
// template literal that never closes, since what follows could not be read.
import { InputError } from "./shared.ts";

export interface Lexed {
  /** The text with each comment blanked; line structure and indices kept. */
  code: string;
  /** For each index of `code`, whether it lies inside a literal. */
  literal: boolean[];
}

/** What the last significant token was, for reading the next `/`. */
type Prev = "operand" | "operator" | "brace" | "lt";

/** What came before the next token: comments carry it over unchanged. */
interface Before {
  /** The word that was the last significant token, or "". */
  word: string;
  /** How many `.` in a row were the last significant tokens. */
  dots: number;
  /** Whether a line ended since the last significant token. */
  newline: boolean;
}

const NOTHING_BEFORE: Before = { word: "", dots: 0, newline: false };

/** Keywords after which an expression, so a regular expression, begins. */
const EXPRESSION_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
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

/** Keywords whose `(...)` head is followed by a statement, not an operator. */
const HEAD_KEYWORDS = new Set(["for", "if", "while", "with"]);

/** A character that starts or continues an identifier, keyword or number. */
const isWordChar = (ch: string): boolean =>
  /[\w$]/.test(ch) || ch.charCodeAt(0) > 127;

/**
 * The index of the `/` that closes a regular expression whose body starts at
 * `from`, or -1 when the line ends first. A `/` inside a character class or
 * after a backslash is part of the body.
 */
function regexClose(text: string, from: number): number {
  let inClass = false;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "\n") return -1;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return j;
  }
  return -1;
}

class Lexer {
  private readonly out: string[] = [];
  private readonly literal: boolean[] = [];
  private i = 0;
  private prev: Prev = "operator";
  private before: Before = { ...NOTHING_BEFORE };
  /** Per open `(`, whether it opens the head of an `if`, `while`, `for` or `with`. */
  private readonly parens: boolean[] = [];
  private inTemplate = false;
  /** Per open `${`, the depth of `{` opened inside it and not yet closed. */
  private readonly frames: number[] = [];

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  run(): Lexed {
    while (this.i < this.text.length)
      if (this.inTemplate) this.templateText();
      else this.codeToken();
    if (this.inTemplate || this.frames.length > 0)
      this.fail("a template literal never closes");
    return { code: this.out.join(""), literal: this.literal };
  }

  private fail(problem: string, at = this.i): never {
    const line = this.text.slice(0, at).split("\n").length;
    throw new InputError(`line ${line}: ${problem}`);
  }

  /** Copy the text up to `end` as it is. */
  private keep(end: number, isLiteral: boolean): void {
    for (; this.i < end; this.i++) {
      this.out.push(this.text[this.i] ?? "");
      this.literal.push(isLiteral);
    }
  }

  /** Blank the text up to `end`, keeping its newlines. */
  private blank(end: number): void {
    for (; this.i < end; this.i++) {
      this.out.push(this.text[this.i] === "\n" ? "\n" : " ");
      this.literal.push(false);
    }
  }

  private codeToken(): void {
    const ch = this.text[this.i] ?? "";
    if (/\s/.test(ch)) {
      if (ch === "\n") this.before.newline = true;
      this.keep(this.i + 1, false);
      return;
    }
    const before = this.before;
    this.before = { ...NOTHING_BEFORE };
    if (ch === "/") this.slash(before);
    else if (ch === '"' || ch === "'") this.quoted(ch);
    else if (ch === "`") {
      this.keep(this.i + 1, true);
      this.inTemplate = true;
    } else if (isWordChar(ch)) this.word(before);
    else this.punctuation(ch, before);
  }

  private punctuation(ch: string, before: Before): void {
    if (ch === "}") this.closeBrace();
    else if ((ch === "+" || ch === "-") && this.text[this.i + 1] === ch)
      this.increment(before.newline);
    else {
      this.open(ch, before.word);
      this.keep(this.i + 1, false);
      if (ch === ".") this.before.dots = before.dots + 1;
      this.prev = this.afterPunctuation(ch);
    }
  }

  /** Track what a `{` or `(` opens. */
  private open(ch: string, word: string): void {
    const top = this.frames.length - 1;
    if (ch === "{" && top >= 0) this.frames[top] = (this.frames[top] ?? 0) + 1;
    if (ch === "(") this.parens.push(HEAD_KEYWORDS.has(word));
  }

  /** What a punctuator other than `}`, `++` and `--` leaves before a `/`. */
  private afterPunctuation(ch: string): Prev {
    if (ch === ")") return this.parens.pop() ? "operator" : "operand";
    if (ch === "]") return "operand";
    return ch === "<" ? "lt" : "operator";
  }

  /**
   * A `++` or `--`: right after an operand on its line it is postfix and
   * ends the operand; anywhere else it is prefix and an operand follows.
   */
  private increment(newline: boolean): void {
    this.keep(this.i + 2, false);
    if (this.prev !== "operand" || newline) this.prev = "operator";
  }

  private closeBrace(): void {
    const top = this.frames.length - 1;
    const depth = this.frames[top];
    if (depth === 0) {
      this.frames.pop();
      this.keep(this.i + 1, true);
      this.inTemplate = true;
      return;
    }
    if (depth !== undefined) this.frames[top] = depth - 1;
    this.keep(this.i + 1, false);
    this.prev = "brace";
  }

  /** A word, read against the significant tokens before it. */
  private word(before: Before): void {
    let end = this.i;
    while (end < this.text.length && isWordChar(this.text[end] ?? "")) end++;
    const word = this.text.slice(this.i, end);
    // A word after one `.` is a property, never a keyword (`a.if(x) / 2`); a
    // spread's `...` is not a property access.
    const property = before.dots === 1;
    this.keep(end, false);
    this.prev =
      EXPRESSION_KEYWORDS.has(word) && !property ? "operator" : "operand";
    // `for await (` opens a loop head as `for (` does.
    if (!property)
      this.before.word =
        word === "await" && before.word === "for" ? "for" : word;
  }

  /** A comment, a division or a regular expression. */
  private slash(before: Before): void {
    const next = this.text[this.i + 1];
    if (next === "/" || next === "*") this.comment(next, before);
    else if (this.prev === "operand" || this.prev === "lt") {
      this.keep(this.i + 1, false);
      this.prev = "operator";
    } else if (this.prev === "brace")
      this.fail(
        "a `/` after a `}` could open a regular expression or divide; wrap the expression in parentheses",
      );
    else this.regex();
  }

  /**
   * A line or block comment, blanked. A comment is no token: what came
   * before it carries over, with the line breaks it holds.
   */
  private comment(next: string, before: Before): void {
    const end = next === "/" ? this.lineEnd() : this.blockEnd();
    const newline = this.text.slice(this.i, end).includes("\n");
    this.blank(end);
    this.before = { ...before, newline: before.newline || newline };
  }

  private lineEnd(): number {
    const end = this.text.indexOf("\n", this.i);
    return end === -1 ? this.text.length : end;
  }

  private blockEnd(): number {
    const end = this.text.indexOf("*/", this.i + 2);
    if (end === -1) this.fail("a block comment never closes");
    return end + 2;
  }

  private regex(): void {
    const close = regexClose(this.text, this.i + 1);
    if (close === -1)
      this.fail("a regular expression never closes on its line");
    let end = close + 1;
    while (/[a-z]/i.test(this.text[end] ?? "")) end++;
    this.keep(end, true);
    this.prev = "operand";
  }

  /** A `'` or `"` string; one left open ends at its line's end. */
  private quoted(quote: string): void {
    let j = this.i + 1;
    while (j < this.text.length && this.text[j] !== "\n") {
      const ch = this.text[j];
      j += ch === "\\" ? 2 : 1;
      if (ch === quote) break;
    }
    this.keep(Math.min(j, this.text.length), true);
    this.prev = "operand";
  }

  /** A template literal's text, up to its closing backtick or a `${`. */
  private templateText(): void {
    for (let j = this.i; j < this.text.length; j++) {
      const ch = this.text[j];
      if (ch === "\\") j++;
      else if (ch === "`") {
        this.keep(j + 1, true);
        this.inTemplate = false;
        this.prev = "operand";
        return;
      } else if (ch === "$" && this.text[j + 1] === "{") {
        this.keep(j + 2, true);
        this.frames.push(0);
        this.inTemplate = false;
        this.prev = "operator";
        return;
      }
    }
    this.fail("a template literal never closes");
  }
}

/** The text split into code and literals; text it cannot read throws. */
export function lex(text: string): Lexed {
  return new Lexer(text).run();
}
