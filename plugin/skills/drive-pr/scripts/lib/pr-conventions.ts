/**
 * The conventions a pull request and its commits follow, beside the policy
 * `pr-policy.ts` reads: the base an item's labels choose
 * (`pull_requests.base_rules`), the title convention (declared, or derived
 * from a commitlint configuration or recent history) and its pattern
 * (`pull_requests.title_pattern`), and the prefix every commit message
 * carries (`pull_requests.commit_prefix`).
 *
 * `pr-policy.ts` parses these fields through `parseConventions`; `do-item`'s
 * `pr-plan.ts` applies the base and the title, and `commit-prefix.ts` the
 * commit prefix.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JigError } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import type { PrPolicy, TitleFormat } from "./pr-policy.ts";
import { git } from "./proc.ts";

const invalid = (message: string) => new JigError("pr-policy-invalid", message);

// ---------------------------------------------------------------------------
// Base rules
// ---------------------------------------------------------------------------

/** One `pull_requests.base_rules` entry: the base an item carrying one of `labels` targets. */
export interface BaseRule {
  labels: string[];
  base: string;
}

/**
 * A branch name as a base names it: no remote prefix is detectable here, so
 * this refuses only what git refuses in any branch name (a leading `-`, `.`
 * or `/`, `..`, `//`, a trailing `/` or `.`, `.lock` at the end) and
 * anything beyond ASCII letters, digits, `.`, `_`, `/` and `-`.
 */
const BRANCH_NAME =
  /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![./])$/;

const isLabelList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((l) => typeof l === "string" && l.trim() !== "");

/** Parse `pull_requests.base_rules`: a list of `{ when: { labels }, base }`, in order. */
export function parseBaseRules(raw: unknown): BaseRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw invalid(
      "pull_requests.base_rules must be a list of { when: { labels: [...] }, base: <branch> }",
    );
  return raw.map((entry, i) => {
    const at = `pull_requests.base_rules[${i}]`;
    if (!isRecord(entry))
      throw invalid(`${at} must be a mapping with when and base`);
    for (const key of Object.keys(entry))
      if (key !== "when" && key !== "base")
        throw invalid(`${at}.${key} is not a known field (when, base)`);
    const when = entry.when;
    if (!isRecord(when) || Object.keys(when).some((k) => k !== "labels"))
      throw invalid(`${at}.when must be a mapping holding labels only`);
    if (!isLabelList(when.labels))
      throw invalid(`${at}.when.labels must be a nonempty list of labels`);
    const base = entry.base;
    if (typeof base !== "string" || !BRANCH_NAME.test(base))
      throw invalid(
        `${at}.base must be a branch name without the remote's prefix (got ${JSON.stringify(base)})`,
      );
    return { labels: when.labels, base };
  });
}

/** The base an item's labels choose, and the rule and label that chose it; `rule` is `null` for the fallback. */
export interface ChosenBase {
  base: string;
  rule: { index: number; label: string } | null;
}

/**
 * The base of the first rule one of whose labels the item carries (labels
 * match in any case, as `labels_from_issue` matches them), else `fallback`,
 * the integration branch.
 */
export function chooseBase(
  rules: readonly BaseRule[],
  issueLabels: readonly string[],
  fallback: string,
): ChosenBase {
  const carried = new Map(issueLabels.map((l) => [l.toLowerCase(), l]));
  for (const [index, rule] of rules.entries()) {
    const label = rule.labels.find((l) => carried.has(l.toLowerCase()));
    if (label !== undefined)
      return {
        base: rule.base,
        rule: { index, label: carried.get(label.toLowerCase()) ?? label },
      };
  }
  return { base: fallback, rule: null };
}

/** Where a chosen base came from, for the plan's lines. */
export function baseSource(chosen: ChosenBase): string {
  return chosen.rule === null
    ? "the integration branch"
    : `pull_requests.base_rules[${chosen.rule.index}], for the item's label ${chosen.rule.label}`;
}

// ---------------------------------------------------------------------------
// Placeholder patterns: the title pattern and the commit prefix
// ---------------------------------------------------------------------------

/** The placeholders `pull_requests.title_pattern` may use. */
export const TITLE_PLACEHOLDERS = ["key", "summary"] as const;

/** The placeholders `pull_requests.commit_prefix` may use. */
export const COMMIT_PREFIX_PLACEHOLDERS = ["key"] as const;

/** Throws unless `pattern` uses each of `allowed` and nothing else, its braces balance, and it is one line. */
function checkPlaceholders(
  field: string,
  pattern: string,
  allowed: readonly string[],
): void {
  const used = [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  for (const name of used)
    if (!allowed.includes(name))
      throw invalid(
        `pull_requests.${field} uses an unknown placeholder {${name}}; the placeholders are ${allowed.map((p) => `{${p}}`).join(", ")}`,
      );
  if (/[{}]/.test(pattern.replace(/\{[a-z]+\}/g, "")))
    throw invalid(
      `pull_requests.${field} has an unbalanced brace: ${JSON.stringify(pattern)}`,
    );
  if (/[\r\n]/.test(pattern))
    throw invalid(`pull_requests.${field} must be one line`);
  for (const name of allowed)
    if (!used.includes(name))
      throw invalid(`pull_requests.${field} must contain {${name}}`);
}

function oneLineString(field: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "")
    throw invalid(`pull_requests.${field} must be a nonempty string`);
  return raw;
}

/** The title `pattern` gives an item: `{key}` its key, `{summary}` the summary. */
export function renderTitle(
  pattern: string,
  key: string,
  summary: string,
): string {
  return pattern
    .replaceAll("{key}", key)
    .replaceAll("{summary}", summary.trim());
}

/** The commit-message prefix `prefix` gives an item's key. */
export function renderCommitPrefix(prefix: string, key: string): string {
  return prefix.replaceAll("{key}", key);
}

/** A key of any tracker Jig knows, as a title carries it: `ENG-12`, `#12`. */
const ANY_KEY = "(?:[A-Z][A-Z0-9]*-\\d+|#[1-9]\\d*)";

/** Whether `title` has the shape `pattern` renders, for any key and a nonempty summary. */
export function matchesTitlePattern(pattern: string, title: string): boolean {
  const source = pattern
    .split(/(\{key\}|\{summary\})/)
    .map((part) =>
      part === "{key}"
        ? ANY_KEY
        : part === "{summary}"
          ? "\\S.*"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(title.trim());
}

/** The conventions `pull_requests` declares beside the core policy. */
export interface Conventions {
  baseRules: BaseRule[];
  /** `null` = not declared; set exactly when `title_format` is `pattern`. */
  titlePattern: string | null;
  /** `null` = no prefix. */
  commitPrefix: string | null;
}

/** Parse `base_rules`, `title_pattern` and `commit_prefix`, checked against the declared `title_format`. */
export function parseConventions(
  section: Record<string, unknown>,
  titleFormat: TitleFormat | null,
): Conventions {
  const titlePattern = oneLineString("title_pattern", section.title_pattern);
  if (titlePattern !== null)
    checkPlaceholders("title_pattern", titlePattern, TITLE_PLACEHOLDERS);
  if ((titleFormat === "pattern") !== (titlePattern !== null))
    throw invalid(
      titlePattern === null
        ? "pull_requests.title_format is pattern, so pull_requests.title_pattern must say it, such as '{key}: {summary}'"
        : "pull_requests.title_pattern needs pull_requests.title_format: pattern",
    );
  const commitPrefix = oneLineString("commit_prefix", section.commit_prefix);
  if (commitPrefix !== null)
    checkPlaceholders(
      "commit_prefix",
      commitPrefix,
      COMMIT_PREFIX_PLACEHOLDERS,
    );
  return {
    baseRules: parseBaseRules(section.base_rules),
    titlePattern,
    commitPrefix,
  };
}

// ---------------------------------------------------------------------------
// The title convention, derived
// ---------------------------------------------------------------------------

const COMMITLINT_FILES = [
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
];

/** A commitlint configuration at the repository root, or `null`. */
export function findCommitlintConfig(root: string): string | null {
  const file = COMMITLINT_FILES.find((f) => existsSync(join(root, f)));
  if (file !== undefined) return file;
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (isRecord(pkg) && pkg.commitlint !== undefined)
      return "package.json (commitlint)";
  } catch {
    // no package.json, or not JSON: no commitlint configuration there
  }
  return null;
}

/**
 * The commitlint configuration when it names the Conventional Commits rules
 * (`@commitlint/config-conventional` or a preset built on it), else `null`.
 * A commitlint configuration alone proves commits are linted, not which
 * convention they follow.
 */
export function conventionalCommitlintConfig(root: string): string | null {
  const found = findCommitlintConfig(root);
  if (found === null) return null;
  let text: string;
  try {
    if (found === "package.json (commitlint)") {
      const pkg = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      text = JSON.stringify(pkg.commitlint);
    } else {
      text = readFileSync(join(root, found), "utf8");
    }
  } catch {
    return null;
  }
  return /conventional/i.test(text) ? found : null;
}

/** A Conventional Commits subject: `type(scope)!: description`. */
export const CONVENTIONAL_SUBJECT = /^[a-z]+(\([^()\s][^()]*\))?!?: \S/;

/** Share of recent trunk subjects that must be conventional to infer the convention. */
export const CONVENTIONAL_SHARE = 0.8;

/**
 * Which title convention recent trunk history follows. Merge commits are
 * skipped (their subjects are generated); fewer than five remaining subjects
 * is too little history to infer anything, so the answer is `free`. A
 * pattern is never inferred: it is declared.
 */
export function inferTitleFormat(
  subjects: string[],
): Exclude<TitleFormat, "pattern"> {
  const own = subjects.filter(
    (s) =>
      s.trim() !== "" &&
      !/^Merge (pull request|branch|remote-tracking)/.test(s),
  );
  if (own.length < 5) return "free";
  const conventional = own.filter((s) => CONVENTIONAL_SUBJECT.test(s)).length;
  return conventional / own.length >= CONVENTIONAL_SHARE
    ? "conventional"
    : "free";
}

/** The title convention and where it came from. */
export async function detectTitleFormat(
  root: string,
  policy: Pick<PrPolicy, "titleFormat">,
  trunkRef: string | null,
): Promise<{ value: TitleFormat; source: string }> {
  if (policy.titleFormat !== null)
    return { value: policy.titleFormat, source: "pull_requests.title_format" };
  const commitlint = conventionalCommitlintConfig(root);
  if (commitlint !== null)
    return { value: "conventional", source: `derived: ${commitlint}` };
  if (trunkRef === null) return { value: "free", source: "default" };
  const log = await git(
    ["-C", root, "log", "--no-merges", "--format=%s", "-n", "30", trunkRef],
    { stderr: "ignore" },
  );
  if (log.code !== 0) return { value: "free", source: "default" };
  const value = inferTitleFormat(log.stdout.split("\n"));
  return {
    value,
    source: `derived: recent subjects on ${trunkRef}`,
  };
}
