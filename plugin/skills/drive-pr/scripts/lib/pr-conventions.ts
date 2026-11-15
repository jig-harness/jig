/**
 * The conventions a pull request and its commits follow, beside the policy
 * `pr-policy.ts` reads: the base an item's labels choose
 * (`pull_requests.base_rules`), the title convention (declared, or derived
 * from a commitlint configuration or recent history) and its pattern
 * (`shared/title-pattern.ts`), and the prefix every commit message
 * carries (`pull_requests.commit_prefix`).
 *
 * `pr-policy.ts` parses these fields through `parseConventions`; `do-item`'s
 * `pr-plan.ts` applies the base and the title, and `commit-prefix.ts` the
 * commit prefix.
 */
import { JigError } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  parseRule,
  type Rule,
  reason,
  resolve,
} from "../../../../shared/rule-matcher.ts";
import { conventionalCommitlintConfig } from "./commitlint.ts";
import type { PrPolicy, TitleFormat } from "./pr-policy.ts";
import { git } from "./proc.ts";

const invalid = (message: string) => new JigError("pr-policy-invalid", message);

// ---------------------------------------------------------------------------
// Base rules
// ---------------------------------------------------------------------------

const BASE_RULES = "pull_requests.base_rules";

/** One `pull_requests.base_rules` entry: the base an item its rule matches targets. */
export interface BaseRule {
  /** The rule under `when`, read by the shared rule matcher. */
  when: Rule;
  base: string;
}

/**
 * A branch name as a base names it: no remote prefix is detectable here, so
 * this refuses only what git refuses in any branch name (a leading `-`, `.`
 * or `/`, `..`, `//`, a trailing `/` or `.`, a component starting with `.` or
 * ending in `.lock`) and
 * anything beyond ASCII letters, digits, `.`, `_`, `/` and `-`.
 */
const BRANCH_NAME =
  /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<![./])$/;

/** Parse `pull_requests.base_rules`: a list of `{ when: <rule>, base }`, in order. */
export function parseBaseRules(raw: unknown): BaseRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw invalid(
      `${BASE_RULES} must be a list of { when: { labels: [...] }, base: <branch> }`,
    );
  return raw.map((entry, i) => {
    const at = `${BASE_RULES}[${i}]`;
    if (!isRecord(entry))
      throw invalid(`${at} must be a mapping with when and base`);
    for (const key of Object.keys(entry))
      if (key !== "when" && key !== "base")
        throw invalid(`${at}.${key} is not a known field (when, base)`);
    const when = parseRule(BASE_RULES, entry.when, `${at}.when`);
    if (!when.ok) throw invalid(when.failure.reason);
    const base = entry.base;
    if (typeof base !== "string" || !BRANCH_NAME.test(base))
      throw invalid(
        `${at}.base must be a branch name without the remote's prefix (got ${JSON.stringify(base)})`,
      );
    return { when: when.value, base };
  });
}

/** The base an item's labels choose, and the rule and label that chose it; `rule` is `null` for the fallback. */
export interface ChosenBase {
  base: string;
  rule: { index: number; label: string } | null;
}

/**
 * The base of the first rule that matches the item, as the rule matcher
 * reads `pull_requests.base_rules`, with the item's label that matched; else
 * `fallback`, the integration branch.
 */
export function chooseBase(
  rules: readonly BaseRule[],
  issueLabels: readonly string[],
  fallback: string,
): ChosenBase {
  const [match] = resolve(
    BASE_RULES,
    rules.map((r) => r.when),
    { labels: issueLabels },
  ).matches;
  const index = typeof match?.at === "number" ? match.at : null;
  const rule = index === null ? undefined : rules[index];
  return match === undefined || index === null || rule === undefined
    ? { base: fallback, rule: null }
    : { base: rule.base, rule: { index, label: match.value } };
}

/** Where a chosen base came from, for the plan's lines: the matcher's reason, or the fallback. */
export function baseSource(chosen: ChosenBase): string {
  if (chosen.rule === null) return "the integration branch";
  const { index, label } = chosen.rule;
  return reason({
    field: BASE_RULES,
    at: index,
    fact: "labels",
    ruleValue: label,
    value: label,
  });
}

// ---------------------------------------------------------------------------
// Placeholder patterns: the title pattern and the commit prefix
// ---------------------------------------------------------------------------

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
  for (const name of allowed) {
    const count = used.filter((u) => u === name).length;
    if (count === 0)
      throw invalid(`pull_requests.${field} must contain {${name}}`);
    if (count > 1)
      throw invalid(`pull_requests.${field} must contain {${name}} once`);
  }
}

function oneLineString(field: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "")
    throw invalid(`pull_requests.${field} must be a nonempty string`);
  return raw;
}

/** The commit-message prefix `prefix` gives an item's key. */
export function renderCommitPrefix(prefix: string, key: string): string {
  return prefix.replaceAll("{key}", () => key);
}

/** The conventions `pull_requests` declares beside the core policy. */
export interface Conventions {
  baseRules: BaseRule[];
  /** `null` = no prefix. */
  commitPrefix: string | null;
}

/** Parse `base_rules` and `commit_prefix`. */
export function parseConventions(
  section: Record<string, unknown>,
): Conventions {
  const commitPrefix = oneLineString("commit_prefix", section.commit_prefix);
  if (commitPrefix !== null)
    checkPlaceholders(
      "commit_prefix",
      commitPrefix,
      COMMIT_PREFIX_PLACEHOLDERS,
    );
  return { baseRules: parseBaseRules(section.base_rules), commitPrefix };
}

// ---------------------------------------------------------------------------
// The title convention, derived
// ---------------------------------------------------------------------------

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
