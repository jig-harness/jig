/**
 * Credential-shaped text, masked: a value named by a key that says it is a
 * secret (`token`, `secret`, `password`, `api_key`, `authorization`, quoted
 * or not), a `Bearer` or `Basic` value, a token in a known vendor's form
 * (`ghp_…`, `github_pat_…`, `sk-…`, `xox…-`, `lin_api_…`) and a JSON Web
 * Token. One list serves every record that must name no secret: the steward
 * digest's durable output summary (`dispatch/lib/pass-output.ts`) and the
 * closing report (`closing-report.ts`), each with its own mark.
 */

/** The names a key carries when its value is a secret. */
const SECRET_KEY =
  "[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*";
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

/**
 * Replace each `prefix` match plus the value after it. The value is a quoted
 * string, a bracketed value, or else what `plain` matches there; `skip`
 * leaves a value already masked alone.
 */
function maskValues(
  text: string,
  prefix: RegExp,
  plain: RegExp,
  render: (m: RegExpExecArray) => string,
  skip?: (rest: string) => boolean,
): string {
  const quoted = new RegExp(QUOTED, "y");
  const plainY = new RegExp(plain.source, "y");
  let out = "";
  let last = 0;
  prefix.lastIndex = 0;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const at = m.index + m[0].length;
    let end = -1;
    quoted.lastIndex = at;
    plainY.lastIndex = at;
    if (skip?.(text.slice(at))) continue;
    if (quoted.test(text)) end = quoted.lastIndex;
    else if (text[at] === "[") end = bracketedEnd(text, at);
    else if (plainY.test(text)) end = plainY.lastIndex;
    if (end < 0) continue;
    out += text.slice(last, m.index) + render(m);
    last = end;
    prefix.lastIndex = end;
  }
  return out + text.slice(last);
}

/** Replace every credential-shaped value in `text` with `mark`. */
export function maskCredentials(text: string, mark: string): string {
  const keyed = maskValues(
    text,
    new RegExp(`(["'])(${SECRET_KEY})\\1\\s*[:=]\\s*`, "gi"),
    /[^\s,}\]]+/,
    (m) => `${m[1]}${m[2]}${m[1]}: "${mark}"`,
  );
  return maskValues(
    keyed
      .replace(
        /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        (_, scheme: string) => `${scheme} ${mark}`,
      )
      .replace(
        new RegExp(`\\b(${SECRET_KEY})\\s*[=:]\\s*${QUOTED}`, "gi"),
        (_, key: string) => `${key}=${mark}`,
      ),
    new RegExp(`\\b(${SECRET_KEY})\\s*[=:]\\s*`, "gi"),
    /\S+/,
    (m) => `${m[1]}=${mark}`,
    (rest) => /^(?:<redacted>|\[(?:redacted|launch token)\])(?!\S)/.test(rest),
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
