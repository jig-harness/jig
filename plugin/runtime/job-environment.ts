/**
 * The variables an installed job runs with beyond the ones Jig writes into
 * it. A scheduled job reads no shell profile, so a credential its runs need
 * (a tracker's, a notification channel's address) has to be in the job
 * itself. Two ways put one there:
 *
 * - **Kept from the installed job.** A variable a person added to an
 *   installed launchd job's `EnvironmentVariables` is carried into the job
 *   an install writes in its place, so a reinstall does not drop it. Jig's
 *   own variables (`managed`) are written fresh, never carried.
 * - **Captured by name.** `--env NAME` reads the variable's value from the
 *   installing shell. It takes a name only, never `NAME=VALUE`, so a value
 *   never reaches shell history or the process list.
 *
 * Either way a value is never shown: a preview names the variables only.
 */
import { failed, ok, type Outcome } from "../shared/outcome.ts";

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

const XML_NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const XML_SPACE = /[ \t\r\n]*/y;
const PLIST_VALUES = new Set([
  "dict",
  "array",
  "string",
  "integer",
  "real",
  "data",
  "date",
  "true",
  "false",
]);
const MAX_PLIST_DEPTH = 64;

/**
 * A plist string's text, its XML escapes undone in one pass, numeric
 * references included; a reference that names no character stays as written.
 */
export function unxml(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|quot|apos|amp));/g,
    (whole, hex?: string, decimal?: string, named?: string) => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? whole;
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/**
 * Whether `value` holds a character a scheduled job or XML 1.0 plist cannot
 * carry: line breaks, NUL, XML 1.0 forbidden control characters, U+FFFE,
 * U+FFFF, or an unpaired UTF-16 surrogate.
 */
export function hasUnwritableChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) return true;
    if (code === 0xfffe || code === 0xffff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

type Tag = { kind: "open" | "close" | "self"; name: string };

/**
 * Cursor over an XML 1.0 plist. Walks comments, tags and nested values
 * structurally in one pass instead of rewriting markup with regular
 * expressions, failing closed whenever markup is malformed or unsupported.
 */
class PlistCursor {
  at = 0;
  readonly text: string;

  constructor(plist: string) {
    this.text = plist.startsWith("\uFEFF") ? plist.slice(1) : plist;
  }

  skipSpace(): number {
    XML_SPACE.lastIndex = this.at;
    const match = XML_SPACE.exec(this.text);
    const len = match ? match[0].length : 0;
    this.at += len;
    return len;
  }

  skipComment(): Outcome<void, "unreadable"> {
    const close = this.text.indexOf("-->", this.at + 4);
    if (close < 0)
      return failed(
        "unreadable",
        "it holds an XML comment that is not closed; remove it, then install again",
      );
    const body = this.text.slice(this.at + 4, close);
    if (body.includes("--") || body.endsWith("-"))
      return failed(
        "unreadable",
        "it holds an XML comment that is not well-formed; remove it, then install again",
      );
    this.at = close + 3;
    return ok(undefined);
  }

  skipPi(): Outcome<void, "unreadable"> {
    const close = this.text.indexOf("?>", this.at + 2);
    if (close < 0)
      return failed(
        "unreadable",
        "it holds an XML processing instruction that is not closed",
      );
    this.at = close + 2;
    return ok(undefined);
  }

  skipDoctype(): Outcome<void, "unreadable"> {
    let i = this.at + 9;
    let quote: string | null = null;
    while (i < this.text.length) {
      const ch = this.text[i];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "[") {
        return failed(
          "unreadable",
          "it holds a DOCTYPE internal subset this reader does not support; remove it, then install again",
        );
      } else if (ch === ">") {
        this.at = i + 1;
        return ok(undefined);
      }
      i += 1;
    }
    return failed(
      "unreadable",
      "it holds a DOCTYPE declaration that is not closed",
    );
  }

  skipTrivia(allowDoctype = false): Outcome<void, "unreadable"> {
    let seenDoctype = false;
    while (this.at < this.text.length) {
      this.skipSpace();
      if (this.text.startsWith("<!--", this.at)) {
        const comment = this.skipComment();
        if (!comment.ok) return comment;
        continue;
      }
      if (this.text.startsWith("<?", this.at)) {
        const pi = this.skipPi();
        if (!pi.ok) return pi;
        continue;
      }
      if (
        allowDoctype &&
        !seenDoctype &&
        this.text.startsWith("<!DOCTYPE", this.at) &&
        /^[ \t\r\n]/.test(this.text[this.at + 9] ?? "")
      ) {
        seenDoctype = true;
        const doctype = this.skipDoctype();
        if (!doctype.ok) return doctype;
        continue;
      }
      break;
    }
    return ok(undefined);
  }

  readName(): string | null {
    XML_NAME.lastIndex = this.at;
    const match = XML_NAME.exec(this.text);
    if (!match) return null;
    this.at = XML_NAME.lastIndex;
    return match[0];
  }

  readTag(): Outcome<Tag, "unreadable"> {
    if (this.text[this.at] !== "<")
      return failed("unreadable", "it holds malformed XML markup");
    if (this.text.startsWith("</", this.at)) {
      this.at += 2;
      const name = this.readName();
      if (!name)
        return failed("unreadable", "it holds a malformed closing tag");
      this.skipSpace();
      if (this.text[this.at] !== ">")
        return failed("unreadable", "it holds a malformed closing tag");
      this.at += 1;
      return ok({ kind: "close", name });
    }
    this.at += 1;
    const name = this.readName();
    if (!name) return failed("unreadable", "it holds a malformed XML tag");
    while (this.at < this.text.length) {
      const space = this.skipSpace();
      if (this.text[this.at] === ">") {
        this.at += 1;
        return ok({ kind: "open", name });
      }
      if (this.text.startsWith("/>", this.at)) {
        this.at += 2;
        return ok({ kind: "self", name });
      }
      if (space === 0)
        return failed("unreadable", "it holds a malformed XML attribute");
      const attr = this.readName();
      if (!attr)
        return failed("unreadable", "it holds a malformed XML attribute");
      this.skipSpace();
      if (this.text[this.at] !== "=")
        return failed("unreadable", "it holds a malformed XML attribute");
      this.at += 1;
      this.skipSpace();
      const quote = this.text[this.at];
      if (quote !== '"' && quote !== "'")
        return failed("unreadable", "it holds an unquoted XML attribute");
      this.at += 1;
      const end = this.text.indexOf(quote, this.at);
      if (end < 0 || this.text.slice(this.at, end).includes("<"))
        return failed("unreadable", "it holds a malformed XML attribute value");
      this.at = end + 1;
    }
    return failed("unreadable", "it holds an XML tag that is not closed");
  }

  readPlainText(
    tag: Tag,
    nonPlainReason: string,
  ): Outcome<string, "unreadable"> {
    if (tag.kind === "self") return ok("");
    const nextLt = this.text.indexOf("<", this.at);
    if (nextLt < 0)
      return failed("unreadable", `its <${tag.name}> element is not closed`);
    const raw = this.text.slice(this.at, nextLt);
    this.at = nextLt;
    if (!this.text.startsWith("</", this.at))
      return failed("unreadable", nonPlainReason);
    const close = this.readTag();
    if (
      !close.ok ||
      close.value.kind !== "close" ||
      close.value.name !== tag.name
    )
      return failed("unreadable", nonPlainReason);
    return ok(unxml(raw));
  }

  skipValue(depth: number, firstTag?: Tag): Outcome<void, "unreadable"> {
    if (depth > MAX_PLIST_DEPTH)
      return failed("unreadable", "its XML nesting is too deep to read safely");
    const tagRes = firstTag ? ok(firstTag) : this.readTag();
    if (!tagRes.ok) return tagRes;
    const tag = tagRes.value;
    if (tag.kind === "close" || !PLIST_VALUES.has(tag.name))
      return failed("unreadable", "it holds an unrecognized plist value");
    if (tag.kind === "self") return ok(undefined);
    if (tag.name === "array") {
      while (true) {
        const trivia = this.skipTrivia();
        if (!trivia.ok) return trivia;
        const next = this.readTag();
        if (!next.ok) return next;
        if (next.value.kind === "close") {
          return next.value.name === "array"
            ? ok(undefined)
            : failed("unreadable", "it holds a mismatched closing tag");
        }
        const item = this.skipValue(depth + 1, next.value);
        if (!item.ok) return item;
      }
    }
    if (tag.name === "dict") {
      while (true) {
        const trivia = this.skipTrivia();
        if (!trivia.ok) return trivia;
        const next = this.readTag();
        if (!next.ok) return next;
        if (next.value.kind === "close") {
          return next.value.name === "dict"
            ? ok(undefined)
            : failed("unreadable", "it holds a mismatched closing tag");
        }
        if (next.value.name !== "key")
          return failed(
            "unreadable",
            "a dictionary entry is missing its <key>",
          );
        const key = this.readPlainText(
          next.value,
          "a dictionary key is not plain text",
        );
        if (!key.ok) return key;
        const afterKey = this.skipTrivia();
        if (!afterKey.ok) return afterKey;
        const val = this.skipValue(depth + 1);
        if (!val.ok) return val;
      }
    }
    if (tag.name === "true" || tag.name === "false") {
      const trivia = this.skipTrivia();
      if (!trivia.ok) return trivia;
      const close = this.readTag();
      if (
        !close.ok ||
        close.value.kind !== "close" ||
        close.value.name !== tag.name
      )
        return failed("unreadable", "it holds a malformed boolean element");
      return ok(undefined);
    }
    while (true) {
      const nextLt = this.text.indexOf("<", this.at);
      if (nextLt < 0)
        return failed("unreadable", `its <${tag.name}> element is not closed`);
      this.at = nextLt;
      if (this.text.startsWith("<!--", this.at)) {
        const comment = this.skipComment();
        if (!comment.ok) return comment;
        continue;
      }
      if (this.text.startsWith("<![CDATA[", this.at)) {
        const end = this.text.indexOf("]]>", this.at + 9);
        if (end < 0)
          return failed(
            "unreadable",
            "it holds a CDATA section that is not closed",
          );
        this.at = end + 3;
        continue;
      }
      if (this.text.startsWith("<?", this.at)) {
        const pi = this.skipPi();
        if (!pi.ok) return pi;
        continue;
      }
      if (this.text.startsWith("</", this.at)) {
        const close = this.readTag();
        if (
          !close.ok ||
          close.value.kind !== "close" ||
          close.value.name !== tag.name
        )
          return failed("unreadable", "it holds a mismatched closing tag");
        return ok(undefined);
      }
      return failed(
        "unreadable",
        `its <${tag.name}> element holds nested markup`,
      );
    }
  }
}

function readEnvironmentDict(
  cursor: PlistCursor,
): Outcome<Record<string, string>, "unreadable"> {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  const nonStringReason =
    "an EnvironmentVariables entry is not a string (a plain <string> without CDATA); make each value one, then install again";
  while (true) {
    const trivia = cursor.skipTrivia();
    if (!trivia.ok) return trivia;
    const keyTag = cursor.readTag();
    if (!keyTag.ok) return keyTag;
    if (keyTag.value.kind === "close") {
      if (keyTag.value.name !== "dict")
        return failed(
          "unreadable",
          "its EnvironmentVariables dictionary is not closed",
        );
      break;
    }
    if (keyTag.value.name !== "key")
      return failed("unreadable", nonStringReason);
    const name = cursor.readPlainText(keyTag.value, nonStringReason);
    if (!name.ok) return name;
    if (seen.has(name.value))
      return failed(
        "unreadable",
        `EnvironmentVariables names ${name.value} more than once, so which value it holds is unclear; keep one entry, then install again`,
      );
    seen.add(name.value);
    const between = cursor.skipTrivia();
    if (!between.ok) return between;
    const valueTag = cursor.readTag();
    if (!valueTag.ok) return valueTag;
    if (valueTag.value.kind === "close" || valueTag.value.name !== "string")
      return failed("unreadable", nonStringReason);
    const value = cursor.readPlainText(valueTag.value, nonStringReason);
    if (!value.ok) return value;
    entries.push([name.value, value.value]);
  }
  // Own data properties, so a variable named `__proto__` stays a variable.
  return ok(Object.fromEntries(entries));
}

/**
 * A launchd job's `EnvironmentVariables`, read whole or not at all: the form
 * `jobFiles` writes, or the same keys laid out on lines of their own, as a
 * person's edit with a plist tool leaves them. XML comments are ignored; an
 * entry that is not a plain `<string>` (CDATA, a number, a nested dictionary)
 * makes the block `unreadable`, never a smaller one. A job with no
 * environment holds none.
 */
export function parseLaunchdEnvironment(
  plist: string,
): Outcome<Record<string, string>, "unreadable"> {
  const cursor = new PlistCursor(plist);
  const prolog = cursor.skipTrivia(true);
  if (!prolog.ok) return prolog;
  const root = cursor.readTag();
  if (!root.ok || root.value.kind !== "open" || root.value.name !== "plist")
    return failed("unreadable", "it is not a <plist> XML document");
  const beforeDict = cursor.skipTrivia();
  if (!beforeDict.ok) return beforeDict;
  const top = cursor.readTag();
  if (!top.ok || top.value.kind === "close" || top.value.name !== "dict")
    return failed("unreadable", "its top-level plist value is not a <dict>");

  let env: Record<string, string> | null = null;
  if (top.value.kind === "open") {
    while (true) {
      const trivia = cursor.skipTrivia();
      if (!trivia.ok) return trivia;
      const keyTag = cursor.readTag();
      if (!keyTag.ok) return keyTag;
      if (keyTag.value.kind === "close") {
        if (keyTag.value.name !== "dict")
          return failed("unreadable", "its top-level dictionary is not closed");
        break;
      }
      if (keyTag.value.name !== "key")
        return failed(
          "unreadable",
          "a top-level plist entry is missing its <key>",
        );
      const key = cursor.readPlainText(
        keyTag.value,
        "it names a plist key in a form this reader does not recognize; write the key as plain text, then install again",
      );
      if (!key.ok) return key;
      if (
        key.value !== "EnvironmentVariables" &&
        key.value.trim() === "EnvironmentVariables"
      )
        return failed(
          "unreadable",
          "it names EnvironmentVariables in a form this reader does not recognize; write the key as plain text, then install again",
        );
      const between = cursor.skipTrivia();
      if (!between.ok) return between;
      if (key.value === "EnvironmentVariables") {
        if (env !== null)
          return failed(
            "unreadable",
            "it names EnvironmentVariables more than once; keep one dictionary, then install again",
          );
        const dictTag = cursor.readTag();
        if (
          !dictTag.ok ||
          dictTag.value.kind === "close" ||
          dictTag.value.name !== "dict"
        )
          return failed(
            "unreadable",
            "its EnvironmentVariables is not a dictionary; make it a <dict> of <string> values, then install again",
          );
        if (dictTag.value.kind === "self") {
          env = {};
        } else {
          const read = readEnvironmentDict(cursor);
          if (!read.ok) return read;
          env = read.value;
        }
      } else {
        const skipped = cursor.skipValue(0);
        if (!skipped.ok) return skipped;
      }
    }
  }

  const afterDict = cursor.skipTrivia();
  if (!afterDict.ok) return afterDict;
  const closePlist = cursor.readTag();
  if (
    !closePlist.ok ||
    closePlist.value.kind !== "close" ||
    closePlist.value.name !== "plist"
  )
    return failed("unreadable", "its <plist> element is not closed");
  const trailing = cursor.skipTrivia();
  if (!trailing.ok) return trailing;
  if (cursor.at !== cursor.text.length)
    return failed("unreadable", "it holds unexpected content after </plist>");
  return ok(env ?? {});
}

/** What a preview shows in place of a value it must not print. */
export const HIDDEN_VALUE = "(hidden)";

/** A variable's name as a shell exports it. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables the installed launchd job (`plist`, null when there is
 * none) holds that are not `managed`: what a reinstall keeps. A job whose
 * variables cannot all be read and written back is `unreadable`, never read
 * as one with none: a binary plist, an entry whose value is not a string,
 * or a kept value with a line break or XML 1.0 forbidden character. No
 * reason repeats a value.
 */
export function carriedEnvironment(
  plist: string | null,
  managed: ReadonlySet<string>,
): Outcome<Record<string, string>, "unreadable"> {
  if (plist === null) return ok({});
  if (!/^\uFEFF?\s*(<\?xml|<!DOCTYPE|<plist)/.test(plist))
    return failed(
      "unreadable",
      "it is not an XML plist; convert it with plutil -convert xml1, then install again",
    );
  const read = parseLaunchdEnvironment(plist);
  if (!read.ok) return failed("unreadable", read.failure.reason);
  const env = read.value;
  const carried = Object.entries(env).filter(([name]) => !managed.has(name));
  const broken = carried.find(([, value]) => hasUnwritableChar(value));
  if (broken)
    return failed(
      "unreadable",
      `the value of ${broken[0]} holds a line break, NUL or XML 1.0 forbidden character, which the installed job cannot keep; rewrite or remove it, then install again`,
    );
  return ok(Object.fromEntries(carried));
}

/**
 * The values of the variables `names` in `env`, the installing shell's, or
 * why they cannot be captured: a `NAME=VALUE` form, a word that is not a
 * name, a variable Jig writes itself (`managed`), or one unset, empty or
 * holding a line break or XML 1.0 forbidden character. No refusal repeats a
 * value.
 */
export function capturedEnvironment(
  names: readonly string[],
  env: Record<string, string | undefined>,
  managed: ReadonlySet<string>,
): Outcome<Record<string, string>, "usage"> {
  const entries: [string, string][] = [];
  for (const name of names) {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    const refusal = captureRefusal(name, value, managed);
    if (refusal !== null) return failed("usage", refusal);
    entries.push([name, value as string]);
  }
  // Own data properties, so a variable named `__proto__` stays a variable.
  return ok(Object.fromEntries(entries));
}

function captureRefusal(
  name: string,
  value: string | undefined,
  managed: ReadonlySet<string>,
): string | null {
  const equals = name.indexOf("=");
  if (equals >= 0) {
    const before = name.slice(0, equals);
    const named = NAME.test(before) ? before : "NAME";
    return `--env takes a variable's name, never NAME=VALUE: a value on the command line lands in shell history and the process list. Export ${named} in this shell, then pass --env ${named}`;
  }
  if (!NAME.test(name))
    return "--env takes a variable's name: letters, digits and underscores, not starting with a digit";
  if (managed.has(name))
    return `--env ${name}: Jig writes ${name} into the job itself`;
  if (value === undefined || value === "")
    return `--env ${name}: ${name} is unset or empty in this shell; export it first`;
  if (hasUnwritableChar(value))
    return `--env ${name}: its value holds a line break, NUL or XML 1.0 forbidden character, which a scheduled job cannot carry`;
  return null;
}

/** `env` with the value of each name in `hidden` replaced by `HIDDEN_VALUE`. */
export function maskedEnvironment(
  env: Record<string, string>,
  hidden: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      hidden.has(name) ? HIDDEN_VALUE : value,
    ]),
  );
}
