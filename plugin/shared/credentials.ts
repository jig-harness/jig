/**
 * Credential-shaped text, masked: a value named by a key that says it is a
 * secret (`token`, `secret`, `password`, `api_key`, `authorization`, quoted
 * or not), a `Bearer` or `Basic` value, a token in a known vendor's form
 * (`ghp_…`, `github_pat_…`, `sk-…`, `xox…-`, `lin_api_…`) and a JSON Web
 * Token. One list serves every record that must name no secret: the steward
 * digest's durable output summary (`dispatch/lib/pass-output.ts`) and the
 * closing report (`closing-report.ts`), each with its own mark. Beside the
 * patterns, every exact secret this process holds is replaced: a provider
 * account's resolved credential (`rememberSecret`), and inside a pass the
 * values of the variables its launch names in `JIG_SECRET_VARIABLES`.
 */

/** The names a key carries when its value is a secret. */
const KEY_CLASS = "[A-Za-z0-9_.-]";
const KEY_WORDS = "token|secret|password|passwd|api[_-]?key|authorization";
const KEY_CHARS = new RegExp(`^${KEY_CLASS}*$`);
const KEY_FRAGMENT = new RegExp(KEY_WORDS, "i");
/** Whether a structured field's name identifies a credential. */
export function isCredentialKey(key: string): boolean {
  // One pass over the allowed characters, then a plain fragment search: the single pattern backtracks over the whole name.
  return KEY_CHARS.test(key) && KEY_FRAGMENT.test(key);
}

/** What a name finder returns: the text it covers and the groups `maskValues` renders from. */
interface NameMatch {
  index: number;
  0: string;
  1: string;
  2: string;
}

/** Finds credential-named keys followed by `=` or `:`; `maskValues` drives it like a global regular expression. */
interface NameFinder {
  lastIndex: number;
  exec(text: string): NameMatch | null;
}

/** Match one maximal name run as a quoted or bare credential assignment; `null` when it is not one. */
function matchNameCandidate(
  text: string,
  candidate: RegExpExecArray,
  quoted: boolean,
  tail: RegExp,
): { match: NameMatch; nextIndex: number } | null {
  if (!isCredentialKey(candidate[0])) return null;
  const end = candidate.index + candidate[0].length;
  const quote = quoted ? (text[candidate.index - 1] ?? "") : "";
  if (quoted && (!/["']/.test(quote) || text[end] !== quote)) return null;
  tail.lastIndex = quoted ? end + 1 : end;
  if (!tail.test(text)) return null;
  const index = quoted ? candidate.index - 1 : candidate.index;
  return {
    match: {
      index,
      0: text.slice(index, tail.lastIndex),
      1: quoted ? quote : candidate[0],
      2: candidate[0],
    },
    nextIndex: tail.lastIndex,
  };
}

/**
 * A finder that reads the text once: each maximal run of name characters is
 * one candidate, tested with `isCredentialKey` and followed by its
 * assignment. No name length matters and no position is scanned twice, so a
 * long word of credential-like fragments costs one pass. A quoted finder
 * wants the same quote either side of the name (groups: quote, name); an
 * unquoted one wants the name alone (group: name).
 */
function nameFinder(quoted: boolean): NameFinder {
  const run = new RegExp(`${KEY_CLASS}+`, "g");
  const tail = /\s*[:=]\s*/y;
  return {
    lastIndex: 0,
    exec(text) {
      run.lastIndex = this.lastIndex;
      for (let r = run.exec(text); r; r = run.exec(text)) {
        const found = matchNameCandidate(text, r, quoted, tail);
        if (found === null) continue;
        this.lastIndex = found.nextIndex;
        return found.match;
      }
      return null;
    },
  };
}

/** A quoted value, either quote, with its escapes. */
const QUOTED = `(?:"(?:[^"\\\\]|\\\\.|"")*"|'(?:[^'\\\\]|\\\\.|'')*')`;

/**
 * End of a bracketed value starting at `start` (a `[`): bracket groups may
 * nest and hold whitespace, an unclosed one takes its line, and the value
 * ends at the first whitespace, `,` or `}` outside every group. A password
 * may contain any number of brackets, so a `]` never ends it by itself.
 */
function bracketedEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\n") break;
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (/\s/.test(c) || c === "," || c === "}")) break;
  }
  return i;
}

const ASSIGNMENT_START = new RegExp(
  `(?:(["'])(${KEY_CLASS}+)\\1|(${KEY_CLASS}+))\\s*[:=]`,
  "y",
);

/**
 * Whether a credential-named assignment begins at `at`, in the grammar
 * `nameFinder` reads (a bare name, or a name inside matching quotes). Only a
 * value that starts after whitespace can be the next assignment: with no
 * boundary the text is the value itself.
 */
function startsAssignment(text: string, at: number): boolean {
  if (!/\s/.test(text[at - 1] ?? "")) return false;
  ASSIGNMENT_START.lastIndex = at;
  const m = ASSIGNMENT_START.exec(text);
  return m !== null && isCredentialKey(m[2] ?? m[3] ?? "");
}

/** Advance past a backslash escape or doubled quote inside a quoted value; `-1` at a closing quote or line break. */
function advanceQuotedChar(text: string, i: number, quote: string): number {
  const c = text[i];
  if (c === "\n") return -1;
  if (c === "\\") return text[i + 1] === "\n" ? -1 : i + 2;
  if (c === quote) return text[i + 1] === quote ? i + 2 : -1;
  return i + 1;
}

/**
 * End of the quoted segment opening at `start`. A value's leading quote may
 * span lines and ends at its closing quote; with none, it takes its first
 * physical line. A quote glued to a bare prefix takes its line only, which
 * is all a line-cutting reader can track.
 */
function quotedEnd(text: string, start: number, multiline: boolean): number {
  const q = text[start] as string;
  let firstBreak = -1;
  let i = start + 1;
  while (i < text.length) {
    const next = advanceQuotedChar(text, i, q);
    if (next !== -1) {
      i = next;
      continue;
    }
    if (text[i] === q) return i + 1;
    const breakAt = text[i] === "\\" ? i + 1 : i;
    if (!multiline) return breakAt;
    if (firstBreak < 0) firstBreak = breakAt;
    i = breakAt + 1;
  }
  return firstBreak >= 0 ? firstBreak : text.length;
}

/** Whether text at `at` starts a field of any name: evidence of a boundary. */
function startsField(text: string, at: number): boolean {
  ASSIGNMENT_START.lastIndex = at;
  return ASSIGNMENT_START.test(text);
}

/**
 * After a closed quote, whether the separator at `i` ends the value: only
 * when a boundary follows (end, whitespace, another separator or a field),
 * so a suffix of the same word stays masked.
 */
function separatorEnds(text: string, i: number): boolean {
  const next = text[i + 1];
  return (
    next === undefined ||
    /\s/.test(next) ||
    next === "," ||
    next === ";" ||
    next === "}" ||
    startsField(text, i + 1)
  );
}

/** Whether `text[i]` ends an unquoted value after a closed quote segment. */
function endsAfterQuote(text: string, i: number, afterQuote: boolean): boolean {
  const c = text[i] ?? "";
  return (
    afterQuote &&
    (c === "," || c === ";" || c === "}") &&
    separatorEnds(text, i)
  );
}

/** Advance one segment (quoted, escaped, or bare character) inside an unquoted value. */
function stepValueSegment(
  text: string,
  start: number,
  i: number,
): { next: number; afterQuote: boolean } {
  const c = text[i] ?? "";
  if (c === '"' || c === "'") {
    const next = quotedEnd(text, i, i === start);
    return { next, afterQuote: text[next - 1] === c };
  }
  if (c === "\\") {
    const step = text[i + 1] === "\n" || text[i + 1] === "\r" ? 1 : 2;
    return { next: i + step, afterQuote: false };
  }
  return { next: i + 1, afterQuote: false };
}

/**
 * End of an unquoted assignment's value: segments (bare, escaped, quoted)
 * run on until whitespace. After a quoted segment closes, `,` `;` and `}`
 * also end the value when a boundary follows, so the neighbouring field
 * survives; a bare run takes them as part of the secret. A backslash before
 * a line break does not continue the value past it.
 */
function valueEnd(text: string, start: number): number {
  let afterQuote = false;
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i] ?? "") || endsAfterQuote(text, i, afterQuote)) break;
    const stepped = stepValueSegment(text, start, i);
    i = stepped.next;
    afterQuote = stepped.afterQuote;
  }
  return Math.min(i, text.length);
}

/** End offset of the credential value starting at `at`, or `-1` when no supported value grammar matches. */
function matchValueEnd(
  text: string,
  at: number,
  quoted: RegExp,
  plainY: RegExp,
  contiguous: boolean,
): number {
  quoted.lastIndex = at;
  plainY.lastIndex = at;
  if (contiguous && text[at] !== "[") {
    if (startsAssignment(text, at)) return -1;
    const end = valueEnd(text, at);
    return end === at ? -1 : end;
  }
  if (quoted.test(text)) return quoted.lastIndex;
  if (text[at] === "[") return bracketedEnd(text, at);
  if (startsAssignment(text, at)) return -1;
  return plainY.test(text) ? plainY.lastIndex : -1;
}

/**
 * Replace each `prefix` match plus the value after it. The value is a quoted
 * string, a bracketed value, or else what `plain` matches there; `skip`
 * leaves a value already masked alone.
 */
function maskValues(
  text: string,
  prefix: NameFinder,
  plain: RegExp,
  render: (m: NameMatch) => string,
  skip?: (rest: string) => boolean,
  contiguous = false,
): string {
  const quoted = new RegExp(QUOTED, "y");
  const plainY = new RegExp(plain.source, "y");
  let out = "";
  let last = 0;
  prefix.lastIndex = 0;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const at = m.index + m[0].length;
    if (skip?.(text.slice(at))) continue;
    const end = matchValueEnd(text, at, quoted, plainY, contiguous);
    if (end < 0) continue;
    out += text.slice(last, m.index) + render(m);
    last = end;
    prefix.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * Exact secret values this process holds, such as a provider account's
 * credential resolved for a launch. Pattern masking cannot recognise an
 * opaque value printed alone, so every value here is replaced wherever
 * `maskCredentials` runs in this process. Values are kept in memory only.
 */
const remembered = new Set<string>();

/**
 * The variable a launch names the environment variables in that hold a
 * resolved secret, comma-separated (`ANTHROPIC_API_KEY`). A Jig script that
 * runs inside the pass reads their values from its own environment and
 * masks them as it masks a remembered value.
 */
export const SECRET_VARIABLES = "JIG_SECRET_VARIABLES";

/** The shortest value replaced exactly: a shorter one would mask ordinary words. */
const SHORTEST_EXACT = 8;

/** Whether exact masking would replace `value`: the one eligibility test every holder of a secret shares. */
export function isMaskable(value: string): boolean {
  return value.length >= SHORTEST_EXACT;
}

/** Remember `value` as a secret this process holds, so every mask replaces it. */
export function rememberSecret(value: string): void {
  if (isMaskable(value)) remembered.add(value);
}

/** The exact secrets this process masks: the remembered ones and the values of the variables `SECRET_VARIABLES` names. */
function exactSecrets(): string[] {
  const env = typeof process === "undefined" ? {} : process.env;
  const named = (env[SECRET_VARIABLES] ?? "")
    .split(",")
    .map((name) => env[name.trim()] ?? "")
    .filter((value) => value.length >= SHORTEST_EXACT);
  // The longest first, so a secret that contains another is replaced whole.
  return [...new Set([...remembered, ...named])].sort(
    (a, b) => b.length - a.length,
  );
}

/** Replace every occurrence of each of `values` (and of every secret this process holds) in `text` with `mark`. */
export function redactExact(
  text: string,
  mark: string,
  values: readonly string[] = [],
): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const value of [...values, ...exactSecrets()]) {
    if (value.length < SHORTEST_EXACT) continue;
    for (let start = text.indexOf(value); start >= 0; ) {
      ranges.push({ start, end: start + value.length });
      start = text.indexOf(value, start + 1);
    }
  }
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let out = "";
  let last = 0;
  for (const range of merged) {
    out += text.slice(last, range.start) + mark;
    last = range.end;
  }
  return out + text.slice(last);
}

/** Replace every credential-shaped value in `text`, and every exact secret this process holds, with `mark`. */
export function maskCredentials(text: string, mark: string): string {
  return maskCredentialShapes(redactExact(text, mark), mark);
}

/** Replace every credential-shaped value in `text` with `mark`, by pattern alone: no remembered secret or variable value takes part. */
export function maskCredentialShapes(text: string, mark: string): string {
  const keyed = maskValues(
    text,
    nameFinder(true),
    /[^\s,}\]]+/,
    (m) => `${m[1]}${m[2]}${m[1]}: "${mark}"`,
  );
  return maskValues(
    keyed.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      (_, scheme: string) => `${scheme} ${mark}`,
    ),
    nameFinder(false),
    /\S+/,
    (m) => `${m[1]}=${mark}`,
    (rest) => /^(?:<redacted>|\[(?:redacted|launch token)\])(?!\S)/.test(rest),
    true,
  )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-|lin_api_)[A-Za-z0-9_-]{8,}/g,
      mark,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
      mark,
    );
}
