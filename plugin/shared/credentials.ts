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
 * A bracketed value: a run of bracket groups (whitespace allowed inside one,
 * an unclosed one taking its line) and non-whitespace text between and after
 * them. A password may contain any number of brackets, so the value ends at
 * the next whitespace outside a bracket group, never at a `]`.
 */
const BRACKET_GROUP = "\\[[^\\]\\n]*\\]?";
const BRACKETED = `${BRACKET_GROUP}(?:${BRACKET_GROUP}|[^\\s,}\\[])*`;

/** Replace every credential-shaped value in `text` with `mark`. */
export function maskCredentials(text: string, mark: string): string {
  return text
    .replace(
      new RegExp(
        `(["'])(${SECRET_KEY})\\1\\s*[:=]\\s*(?:${QUOTED}|${BRACKETED}|[^\\s,}\\]]+)`,
        "gi",
      ),
      (_, q: string, key: string) => `${q}${key}${q}: "${mark}"`,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      (_, scheme: string) => `${scheme} ${mark}`,
    )
    .replace(
      new RegExp(`\\b(${SECRET_KEY})\\s*[=:]\\s*${QUOTED}`, "gi"),
      (_, key: string) => `${key}=${mark}`,
    )
    .replace(
      new RegExp(
        `\\b(${SECRET_KEY})\\s*[=:]\\s*(?!(?:<redacted>|\\[(?:redacted|launch token)\\])(?!\\S))(?:${BRACKETED}|\\S+)`,
        "gi",
      ),
      (_, key: string) => `${key}=${mark}`,
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
