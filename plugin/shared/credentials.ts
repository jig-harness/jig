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
const SECRET_KEY =
  "[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*";
const KEY_CHARS = /^[A-Za-z0-9_.-]*$/;
const KEY_FRAGMENT = /token|secret|password|passwd|api[_-]?key|authorization/i;
/** Whether a structured field's name identifies a credential. */
export function isCredentialKey(key: string): boolean {
  // One pass over the allowed characters, then a plain fragment search: the single pattern backtracks over the whole name.
  return KEY_CHARS.test(key) && KEY_FRAGMENT.test(key);
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
  let out = text;
  for (const value of [...values, ...exactSecrets()])
    if (value.length >= SHORTEST_EXACT) out = out.split(value).join(mark);
  return out;
}

/** Replace every credential-shaped value in `text`, and every exact secret this process holds, with `mark`. */
export function maskCredentials(text: string, mark: string): string {
  return maskCredentialShapes(redactExact(text, mark), mark);
}

/** Replace every credential-shaped value in `text` with `mark`, by pattern alone: no remembered secret or variable value takes part. */
export function maskCredentialShapes(text: string, mark: string): string {
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
