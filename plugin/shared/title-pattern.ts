/**
 * The pull-request title pattern (`pull_requests.title_pattern`): a title
 * template with the issue key and the summary as placeholders, for
 * repositories whose protected branches require the tracker key in every
 * commit. With squash merges the title is that commit's subject.
 *
 * Pure functions, read by the pull-request policy (validation), `pr-plan.ts`
 * (rendering) and the audit (matching the pattern against recent trunk
 * subjects).
 */

import { JigError } from "./errors.ts";

/** The placeholders a title pattern uses; each appears exactly once. */
const TITLE_PLACEHOLDERS = ["key", "summary"] as const;

/** Share of recent trunk subjects that must match the pattern for it to fit. */
export const TITLE_SHARE = 0.8;

/** Fewest subjects the history needs to judge a pattern from. */
const TITLE_MIN_SUBJECTS = 5;

/**
 * How a tracker writes an issue key in a title: `prefixed` (`ENG-123`, Linear
 * and Jira) or `hash` (`#123`, GitHub Issues).
 */
export type KeyForm = "prefixed" | "hash";

const KEY_SHAPES: Record<KeyForm, string> = {
  prefixed: String.raw`[A-Za-z][A-Za-z0-9]*-\d+`,
  hash: String.raw`#[1-9]\d*`,
};

/** The suffix a squash merge appends to a subject: ` (#123)`. */
const SQUASH_SUFFIX = String.raw`(?: \(#\d+\))?`;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Throws unless `pattern` is a usable title pattern. */
export function validateTitlePattern(pattern: string): void {
  const names = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
  for (const name of names)
    if (!(TITLE_PLACEHOLDERS as readonly string[]).includes(name))
      throw new JigError(
        "pr-policy-invalid",
        `pull_requests.title_pattern uses an unknown placeholder {${name}}; the placeholders are ${TITLE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
      );
  if (/[\r\n]/.test(pattern))
    throw new JigError(
      "pr-policy-invalid",
      `pull_requests.title_pattern must be a single line (got ${JSON.stringify(pattern)})`,
    );
  for (const placeholder of TITLE_PLACEHOLDERS)
    if (names.filter((n) => n === placeholder).length !== 1)
      throw new JigError(
        "pr-policy-invalid",
        `pull_requests.title_pattern must contain {${placeholder}} exactly once (got ${JSON.stringify(pattern)})`,
      );
  if (/[{}]/.test(pattern.replace(PLACEHOLDER, "")))
    throw new JigError(
      "pr-policy-invalid",
      `pull_requests.title_pattern has an unbalanced brace: ${JSON.stringify(pattern)}`,
    );
}

/**
 * `pull_requests.title_pattern` from the `pull_requests` section: `null`
 * unless `format` is `pattern`, which requires it. Throws on a pattern that
 * is not a nonempty string, is not usable, or is set under another format.
 */
export function parseTitlePattern(
  section: Record<string, unknown>,
  format: string | null,
): string | null {
  const value = section.title_pattern;
  const declared = value !== undefined && value !== null;
  if (format !== "pattern") {
    if (declared)
      throw new JigError(
        "pr-policy-invalid",
        "pull_requests.title_pattern needs pull_requests.title_format set to pattern",
      );
    return null;
  }
  if (!declared)
    throw new JigError(
      "pr-policy-invalid",
      "pull_requests.title_format pattern needs pull_requests.title_pattern, such as {key}: {summary}",
    );
  if (typeof value !== "string" || value.trim() === "")
    throw new JigError(
      "pr-policy-invalid",
      "pull_requests.title_pattern must be a nonempty string",
    );
  validateTitlePattern(value);
  return value;
}

/** The title for `key` and `summary` under `pattern`. */
export function renderTitle(
  pattern: string,
  key: string,
  summary: string,
): string {
  return pattern.replace(PLACEHOLDER, (_, name: string) =>
    name === "key" ? key : summary,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Whether the pattern ends in a space and a `hash` key in parentheses, which
 * cannot be told from a squash merge's ` (#n)` suffix, so the pattern cannot
 * be judged from subjects. Other literal text before the parenthesis, such as
 * `-` or `[`, is something the suffix cannot supply.
 */
export function keyIsAmbiguous(pattern: string, form: KeyForm): boolean {
  return form === "hash" && / \(\{key\}\)$/.test(pattern);
}

/** Whether `subject` is a title `pattern` renders, ignoring a squash merge's ` (#n)` suffix. */
export function matchesTitlePattern(
  pattern: string,
  subject: string,
  form: KeyForm,
): boolean {
  let source = "";
  let last = 0;
  for (const m of pattern.matchAll(PLACEHOLDER)) {
    source += escapeRegExp(pattern.slice(last, m.index));
    source += m[1] === "key" ? KEY_SHAPES[form] : String.raw`\S.*`;
    last = m.index + m[0].length;
  }
  source += escapeRegExp(pattern.slice(last));
  return new RegExp(`^${source}${SQUASH_SUFFIX}$`).test(subject);
}

/**
 * How many of `subjects` follow `pattern`; callers pass non-merge commits
 * only. `null` when fewer than `TITLE_MIN_SUBJECTS`
 * remain: too little history to judge from.
 */
export function titlePatternShare(
  pattern: string,
  subjects: readonly string[],
  form: KeyForm,
): { matching: number; total: number } | null {
  const own = subjects.filter((s) => s.trim() !== "");
  if (own.length < TITLE_MIN_SUBJECTS) return null;
  return {
    matching: own.filter((s) => matchesTitlePattern(pattern, s, form)).length,
    total: own.length,
  };
}
