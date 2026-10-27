/**
 * Reading a review finding's severity from the comment that raised it.
 *
 * Every automated reviewer writes severity its own way: a bold word after a
 * coloured circle, a priority badge image (Markdown or HTML), one field of a
 * pipe-delimited header. A SEVERITY FORMAT says how one reviewer writes it:
 * the reviewer's login, the shape of the field, and how the reviewer's own
 * words map onto Jig's severities (`blocker`, `high`, `medium`, `low`).
 *
 * The invariant: a format is read only from comments its own login posted.
 * A shape check narrows what counts as a severity field, but cannot close
 * the decoy class, because ordinary prose produces every one of these shapes
 * by coincidence (`**Expected** | **Critical** | **Actual**` in a bug
 * report). Authorship closes it.
 *
 * A comment no format reads is `unknown`. That is the safe failure where
 * severity is listed in `fail_open.inert_when_unknown` (`review-triage.yaml`):
 * the decline ladder stays inert for the finding instead of declining work on
 * a severity nobody wrote. Where it is not listed, the severity clause
 * abstains and the ladder's other clauses decide.
 *
 * The formats in force, in the order they are tried for a login:
 *
 *   1. the repository's own, from `review.severity_formats`;
 *   2. the built-in ones (`BUILTIN_FORMATS`), each checked against the
 *      reviewer's real comments before it was added;
 *   3. Jig's own finding format (the `bold-token` shape with Jig's words),
 *      for the repository's configured reviewer: its app
 *      (`review.reviewer_app`), else the logins in `review.bots`.
 */
import { reviewBots, reviewerApp, reviewSeverityFormats } from "./overlay.ts";
import { configSource } from "../../../../shared/consumer.ts";
import { DecodeError } from "../../../../shared/guards.ts";

/**
 * Jig's severities, strongest first. The same set as `CANONICAL_SEVERITIES`
 * in resolve-review-comments' `ladder.ts`, which validates `severity_order`
 * against it; a mapping onto any other word would fail that validation.
 */
const JIG_SEVERITIES = ["blocker", "high", "medium", "low"] as const;
type JigSeverity = (typeof JIG_SEVERITIES)[number];

/** The shapes a severity field can take; see `matchShape`. */
const SEVERITY_SHAPES = [
  "bold-token",
  "badge",
  "html-badge",
  "pipe-fields",
  "icon-fields",
] as const;
type SeverityShape = (typeof SEVERITY_SHAPES)[number];

export interface SeverityFormat {
  /** The GitHub login that posts the comments; a `[bot]` suffix is optional. */
  login: string;
  shape: SeverityShape;
  /** The reviewer's own word (matched case-insensitively) → Jig's severity. */
  severities: Readonly<Record<string, JigSeverity>>;
}

/**
 * The formats Jig recognises without configuration. Each was checked against
 * that reviewer's real comments before it was added here.
 */
export const BUILTIN_FORMATS: readonly SeverityFormat[] = [
  // Codex's GitHub connector: `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Title**`.
  {
    login: "chatgpt-codex-connector",
    shape: "badge",
    severities: { P0: "blocker", P1: "high", P2: "medium", P3: "low" },
  },
  // Greptile: `<a href="#"><img alt="P1" src="…/badges/p1.svg?v=9" align="top"></a> **Title**`,
  // sometimes with a category badge after the priority one. Its scale stops
  // at P2 (medium).
  {
    login: "greptile-apps",
    shape: "html-badge",
    severities: { P0: "blocker", P1: "high", P2: "medium" },
  },
  // CodeRabbit: `**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**`,
  // or the same fields in `_italic_`; newer comments lead with the severity
  // under an icon image: `**<picture><img …> Major** · **Category** · **Effort**`.
  // Its words have no `medium`, and Jig has nothing below `low`, so `Minor`
  // and `Trivial` both take `low`.
  ...(["pipe-fields", "icon-fields"] as const).map(
    (shape): SeverityFormat => ({
      login: "coderabbitai",
      shape,
      severities: {
        Critical: "blocker",
        Major: "high",
        Minor: "low",
        Trivial: "low",
      },
    }),
  ),
];

/** Jig's own finding format: `🟡 **medium** · 🏷️ category: correctness`. */
const JIG_WORDS: Readonly<Record<string, JigSeverity>> = Object.fromEntries(
  JIG_SEVERITIES.map((s) => [s, s]),
);

/** A login compared the way GitHub does: case-insensitively, `[bot]` optional. */
export function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wordsAlternation = (words: readonly string[]): string =>
  words.map(escapeRegExp).join("|");

/**
 * The coloured circles reviewers put before a severity word. A closed list
 * rather than a Unicode property (`\p{Extended_Pictographic}` admits every
 * emoji, so a title opening with a warning sign would read as a severity).
 * A circle may carry a variation selector (VS16), bound to that circle: a
 * selector with no circle before it is an invisible code point in prose, not
 * decoration. A zero-width joiner is never decoration here, since no circle
 * takes part in a joined emoji sequence.
 */
const CIRCLE = "[\\u{1F534}\\u{1F535}\\u{1F7E0}-\\u{1F7E4}\\u{26AA}\\u{26AB}]";

/**
 * `bold-token`: on line 0 of the header, only spaces, tabs and coloured
 * circles, then the bold word: `🟡 **medium**`, `**high**`.
 *
 * These properties keep prose from matching:
 *
 * - The prefix lists what may appear rather than excluding letters, so
 *   `` `**low**` is a supported token `` (a backtick) and
 *   `3 **low**-level branches` (a digit) are not severities.
 * - Whitespace is `[ \t]`, never `\s`, and there is no `m` flag, so the
 *   match cannot walk to line 1: `^` is the start of the header.
 * - The decoration is an alternation, not one character class, so VS16 can
 *   follow only the circle it decorates (biome's
 *   `noMisleadingCharacterClass` also rejects a class mixing the two).
 */
function boldTokenPattern(words: readonly string[]): RegExp {
  return new RegExp(
    `^(?:[ \\t]|${CIRCLE}(?:\\uFE0F)?)*\\*\\*(${wordsAlternation(words)})\\*\\*`,
    "iu",
  );
}

/**
 * Jig's own severity field. `categoryOf` (summary-findings.ts) derives its
 * lead-field check from this pattern, so the two agree on what a severity
 * field is.
 */
export const SEVERITY_FIELD = boldTokenPattern(JIG_SEVERITIES);

/**
 * `badge`: a shields.io badge whose alt text is the word, at the start of
 * line 0, optionally inside bold and up to two `<sub>` tags:
 * `**<sub><sub>![P1 Badge](…)</sub></sub>  Title**`. Whitespace is `[ \t]`,
 * for the same line-0 reason as `bold-token`.
 */
function badgePattern(words: readonly string[]): RegExp {
  return new RegExp(
    `^[ \\t]*\\*{0,2}(?:<sub>[ \\t]*){0,2}!\\[[ \\t]*(${wordsAlternation(words)})[ \\t]*Badge\\]`,
    "iu",
  );
}

/**
 * `html-badge`: an HTML image whose alt text is the word, at the start of
 * line 0, optionally inside one link: `<a href="#"><img alt="P1" src="…"></a>`.
 * The tags are parsed, not searched: each must be named exactly (`<img-x>` is
 * not `<img>`) and close on line 0, and an attribute value is skipped whole,
 * quotes respected, so text inside one (`title=' alt="P2" '`) is never read as
 * an attribute. The word is the `alt` attribute's own value, the first one
 * where a tag repeats it; `data-alt` is a different attribute.
 */
function htmlBadgeWord(
  header: string,
  words: readonly string[],
): string | null {
  const line0 = header.split("\n", 1)[0] ?? "";
  let pos = line0.match(/^[ \t]*/u)?.[0].length ?? 0;
  const link = parseTag(line0, pos, "a");
  if (link !== null)
    pos = link.end + (line0.slice(link.end).match(/^[ \t]*/u)?.[0].length ?? 0);
  const img = parseTag(line0, pos, "img");
  const alt = img?.attributes.get("alt");
  if (alt === undefined) return null;
  return words.find((w) => w.toLowerCase() === alt.toLowerCase()) ?? null;
}

/**
 * The start tag `<name …>` at `pos` in `line`: its attributes (names
 * lowercased, the first of a repeated name kept) and the index after its `>`;
 * `null` when anything there is not a well-formed start tag of that name.
 */
function parseTag(
  line: string,
  pos: number,
  name: string,
): { attributes: Map<string, string>; end: number } | null {
  const open = new RegExp(`^<${name}(?=[ \\t/>])`, "iu");
  if (!open.test(line.slice(pos))) return null;
  const attribute =
    /^[ \t]+([^\s"'<>/=]+)(?:[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/u;
  const attributes = new Map<string, string>();
  let i = pos + name.length + 1;
  for (;;) {
    const close = line.slice(i).match(/^[ \t]*\/?>/u);
    if (close) return { attributes, end: i + close[0].length };
    const m = line.slice(i).match(attribute);
    if (!m) return null;
    const key = (m[1] ?? "").toLowerCase();
    if (!attributes.has(key)) attributes.set(key, m[2] ?? m[3] ?? m[4] ?? "");
    i += m[0].length;
  }
}

/** One `**bold**` or `_italic_` field, end to end; its content, or `null`. */
const EMPHASIZED_FIELD = /^(?:_(.+)_|\*\*((?:(?!\*\*).)+)\*\*)$/u;

function emphasizedContent(field: string | undefined): string | null {
  const m = (field ?? "").match(EMPHASIZED_FIELD);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * `pipe-fields`: line 0 of the header is exactly three emphasized fields
 * separated by `|` (category, severity, effort), and the middle one is the
 * word, optionally after one coloured circle. Parsed by field position, not
 * searched for: a two- or four-field line, or a lead or trailing field that
 * is not emphasized end to end, reads nothing. The emphasis marker (`**` or
 * `_`) is accepted either way, since a reviewer can change it without
 * changing its format.
 */
function pipeFieldsWord(
  header: string,
  words: readonly string[],
): string | null {
  const line0 = header.split("\n", 1)[0] ?? "";
  const fields = line0.split("|").map((f) => f.trim());
  if (
    fields.length !== 3 ||
    emphasizedContent(fields[0]) === null ||
    emphasizedContent(fields[2]) === null
  ) {
    return null;
  }
  const severity = new RegExp(
    `^(?:${CIRCLE}[ \\t]*)?(${wordsAlternation(words)})$`,
    "iu",
  );
  return emphasizedContent(fields[1])?.match(severity)?.[1] ?? null;
}

/**
 * `icon-fields`: line 0 of the header is two or more emphasized fields
 * separated by `·` (severity, category, optionally effort), and the first one
 * is the word, after an optional `<picture>…</picture>` icon and one coloured
 * circle: `**<picture><img …></picture> Major** · **Category** · **Quick win**`.
 * Parsed by field position, like `pipe-fields`.
 */
function iconFieldsWord(
  header: string,
  words: readonly string[],
): string | null {
  const line0 = header.split("\n", 1)[0] ?? "";
  const fields = line0.split("·").map((f) => f.trim());
  if (
    fields.length < 2 ||
    fields.slice(1).some((f) => emphasizedContent(f) === null)
  ) {
    return null;
  }
  const lead = emphasizedContent(fields[0]);
  if (lead === null) return null;
  const severity = new RegExp(
    `^(?:<picture>(?:(?!</picture>).)*</picture>[ \\t]*)?(?:${CIRCLE}[ \\t]*)?(${wordsAlternation(words)})$`,
    "iu",
  );
  return lead.match(severity)?.[1] ?? null;
}

/**
 * The block a finding's severity and category are read from: leading
 * `<!-- ai-review-* -->` comments (Jig's finding format's own markers) and
 * CodeRabbit's `<!-- coderabbit-ai-generated:v1 -->`
 * stripped, then everything up to the first blank line. A matcher reading
 * the whole comment would take a severity quoted as an example in the body.
 * Only those markers are stripped: stripping any leading HTML comment would
 * expose whatever paragraph follows it as the header.
 */
export function headerOf(text: string): string {
  const withoutLeadingComments = text.replace(
    /^(?:\s*<!--\s*(?:ai-review-|coderabbit-ai-generated)[\s\S]*?-->\s*)+/,
    "",
  );
  return withoutLeadingComments.split(/\n\s*\n/, 1)[0] ?? "";
}

/** The reviewer's word in `header` under `shape`, or `null`. */
function matchShape(
  shape: SeverityShape,
  header: string,
  words: readonly string[],
): string | null {
  switch (shape) {
    case "bold-token":
      return header.match(boldTokenPattern(words))?.[1] ?? null;
    case "badge":
      return header.match(badgePattern(words))?.[1] ?? null;
    case "html-badge":
      return htmlBadgeWord(header, words);
    case "pipe-fields":
      return pipeFieldsWord(header, words);
    case "icon-fields":
      return iconFieldsWord(header, words);
  }
}

/**
 * `text` read in Jig's own finding format with no login check, for text
 * whose author is already established: the bullets of the reviewer's sticky
 * comment, which is found by its author's login.
 */
export function jigSeverityOf(text: string): JigSeverity | "unknown" {
  const word = headerOf(text).match(SEVERITY_FIELD)?.[1];
  return word === undefined ? "unknown" : (word.toLowerCase() as JigSeverity);
}

/** One format's reading of `header`: a Jig severity, or `null`. */
function readSeverity(
  format: SeverityFormat,
  header: string,
): JigSeverity | null {
  const word = matchShape(format.shape, header, Object.keys(format.severities));
  if (word === null) return null;
  const lower = word.toLowerCase();
  for (const [key, severity] of Object.entries(format.severities)) {
    if (key.toLowerCase() === lower) return severity;
  }
  return null;
}

/** A reviewer's word: letters and digits, words separated by single spaces. */
const WORD = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;

type Fail = (why: string) => never;

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One entry's `severities`: each word well formed, distinct, mapped to Jig's. */
function parseWords(
  raw: unknown,
  at: string,
  fail: Fail,
): Record<string, JigSeverity> {
  if (!isMapping(raw)) {
    return fail(`${at}.severities must be a mapping of word to severity`);
  }
  const words = Object.entries(raw);
  if (words.length === 0) fail(`${at}.severities must not be empty`);
  const seen = new Set<string>();
  for (const [word, severity] of words) {
    if (!WORD.test(word)) {
      fail(
        `${at}.severities: '${word}' must be letters and digits, words separated by single spaces`,
      );
    }
    if (seen.has(word.toLowerCase())) {
      fail(`${at}.severities: '${word}' is listed twice, ignoring case`);
    }
    seen.add(word.toLowerCase());
    if (!JIG_SEVERITIES.includes(severity as JigSeverity)) {
      fail(
        `${at}.severities.${word} must be one of ${JIG_SEVERITIES.join(", ")}`,
      );
    }
  }
  return raw as Record<string, JigSeverity>;
}

function parseEntry(entry: unknown, at: string, fail: Fail): SeverityFormat {
  if (!isMapping(entry)) return fail(`${at} must be a mapping`);
  const unknownKeys = Object.keys(entry).filter(
    (k) => !["login", "shape", "severities"].includes(k),
  );
  if (unknownKeys.length > 0) {
    fail(`${at} has unknown field(s) ${unknownKeys.join(", ")}`);
  }
  const { login, shape } = entry;
  if (typeof login !== "string" || normalizeLogin(login) === "") {
    return fail(`${at}.login must be a nonempty login`);
  }
  if (!SEVERITY_SHAPES.includes(shape as SeverityShape)) {
    fail(`${at}.shape must be one of ${SEVERITY_SHAPES.join(", ")}`);
  }
  return {
    login,
    shape: shape as SeverityShape,
    severities: parseWords(entry.severities, at, fail),
  };
}

/**
 * Validate `review.severity_formats`: a list of `{ login, shape, severities }`.
 * A malformed entry is an error naming the field, never skipped: a skipped
 * entry would leave that reviewer's findings `unknown` with nothing saying
 * why.
 */
export function parseSeverityFormats(
  raw: unknown,
  source = "review.severity_formats",
): SeverityFormat[] {
  if (raw === undefined || raw === null) return [];
  const fail: Fail = (why) => {
    throw new DecodeError(source, "review.severity_formats", why);
  };
  if (!Array.isArray(raw)) return fail("must be a list");
  return raw.map((entry, i) => parseEntry(entry, `[${i}]`, fail));
}

/** Jig's own format for each login of the repository's configured reviewer. */
export function jigFormats(
  reviewerLogins: readonly string[],
): SeverityFormat[] {
  return reviewerLogins.map((login) => ({
    login,
    shape: "bold-token",
    severities: JIG_WORDS,
  }));
}

/** The configured reviewer's logins: its app, else `review.bots`. */
function configuredReviewerLogins(): string[] {
  const app = reviewerApp();
  return app !== "" ? [app] : reviewBots();
}

/** The formats in force in this repository, in the order they are tried. */
function severityFormats(): SeverityFormat[] {
  return [
    ...parseSeverityFormats(
      reviewSeverityFormats(),
      configSource("review.severity_formats"),
    ),
    ...BUILTIN_FORMATS,
    ...jigFormats(configuredReviewerLogins()),
  ];
}

/**
 * The severity of the finding `text` raised, read with the formats belonging
 * to `authorLogin` (the raising comment's own login; `null` when GitHub
 * reported none, which reads `unknown`). The first format that reads a
 * severity wins; none → `unknown`.
 */
export function severityOf(
  text: string,
  authorLogin: string | null | undefined,
  formats: readonly SeverityFormat[] = severityFormats(),
): JigSeverity | "unknown" {
  if (authorLogin == null || normalizeLogin(authorLogin) === "") {
    return "unknown";
  }
  const author = normalizeLogin(authorLogin);
  const header = headerOf(text);
  for (const format of formats) {
    if (normalizeLogin(format.login) !== author) continue;
    const severity = readSeverity(format, header);
    if (severity !== null) return severity;
  }
  return "unknown";
}

/**
 * The severity of a bullet in the reviewer's summary (sticky) comment, posted
 * by `stickyAuthor`. The sticky is found by that login, so Jig's own format
 * always applies to it, after the formats the author has in force here (the
 * repository's, the built-in ones). With no author, Jig's format alone.
 */
export function stickySeverityOf(
  text: string,
  stickyAuthor: string | null | undefined,
): JigSeverity | "unknown" {
  if (stickyAuthor == null || normalizeLogin(stickyAuthor) === "") {
    return jigSeverityOf(text);
  }
  return severityOf(text, stickyAuthor, [
    ...severityFormats(),
    ...jigFormats([stickyAuthor]),
  ]);
}
