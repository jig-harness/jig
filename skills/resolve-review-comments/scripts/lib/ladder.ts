import { consumerRoot } from "./consumer.ts";
/**
 * The escalating decline ladder (TASK): load `.config/review-triage.yaml`
 * and resolve one otherwise-`accepted` finding to a stance.
 *
 * The config is the single source for the weights — this module owns only the
 * MECHANISM (band selection, clause evaluation, fail-open polarity) and reads
 * every threshold, category set and macro from the file. A retune is a config
 * edit; nothing here or in the rubric prose changes.
 *
 * ── Fail-open polarity, stated once ────────────────────────────────────────
 *
 * The ladder only ever DECLINES. So every uncertainty resolves toward
 * `accepted`, which is the pre-ladder rubric's own answer:
 *
 *   - config absent, unparseable, or structurally invalid  -> inert (accepted)
 *   - round 0, or a round matching no band                 -> inert (accepted)
 *   - an input listed in `fail_open.inert_when_unknown`
 *     whose value is `unknown`                             -> inert (accepted)
 *
 * An `unknown` input NOT on that list is merely INDETERMINATE: its own clause
 * cannot match, and the band's other clauses still decide. That asymmetry is
 * the point — a clause can only ever ADMIT, so an unreadable input can never
 * be the reason a finding was declined, only a reason one was not rescued.
 * Every such abstention is reported in `abstained` so a caller can see which
 * evidence was missing rather than inferring it.
 *
 * Every inert path is ANNOUNCED (`anomalies`), never silent — the same
 * discipline `current-round.ts` applies to its own fail-open read: the value
 * fails open, the silence does not.
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping): only `node:` APIs,
 * erasable-syntax-only TypeScript, explicit `.ts` import specifiers.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Repo-relative — the canonical config's display label. This is what the
 * reply macros interpolate as `{config}` ONLY when the config actually
 * loaded was this canonical file; `loadLadder` compares the resolved path it
 * was given against this file's own absolute path and falls back to that
 * resolved path verbatim otherwise, so a `--config PATH` override or
 * `$GROUNDWORK_REVIEW_TRIAGE_CONFIG` trial never gets attributed to the
 * canonical source it did not use (chatgpt-codex-connector, a reference-implementation pull request).
 */
export const LADDER_CONFIG_RELPATH = ".config/review-triage.yaml";

/**
 * The repo root, from this module's own location:
 *   .claude/skills/resolve-review-comments/scripts/lib -> repo root
 * Derived by walking up past each of those segments, rather than searched for
 * a `.git` marker: a Conductor worktree's `.git` is a FILE, `git rev-parse`
 * would need a subprocess in a module whose whole contract is "no side
 * effects", and the skill's own path depth is a fact this repo controls.
 */
export function repoRootFrom(libDir: string): string {
  return dirname(dirname(dirname(dirname(dirname(libDir)))));
}

export const SEVERITY_UNKNOWN = "unknown";
export const CATEGORY_UNKNOWN = "unknown";

/**
 * The exact token set `severityOf` (drive-pr/scripts/summary-findings.ts) can
 * produce, duplicated here rather than imported — same convention as
 * reply-to-thread.ts's duplication of drive-pr/lib/outcome.ts's markers — so
 * `severity_order` can be validated as a permutation of what a real finding
 * will actually carry, not merely "a list of strings". A config that renames
 * or drops one of these makes the real producer value unranked and silently
 * abstaining rather than invalidating the config (rule 1,
 * .claude/rules/document-scanning-gates.md).
 */
export const CANONICAL_SEVERITIES = ["low", "medium", "high", "blocker"];

/**
 * The rubric's own tier domain (1 CI/gates, 2 production code, 3 docs, 4
 * tests — triage-ladder.ts's usage doc states the same numbers). Exported
 * from here, the mechanism module, rather than left as a second hardcoded
 * pair in the CLI: `accept_if.max_tier` (parseBand, below) and `--tier`
 * (triage-ladder.ts) both bound the identical value, and two independent
 * literals are exactly how the lower bound stayed enforced on both sides
 * while the upper bound silently existed on only one (PR #4501 round 2).
 */
export const MIN_TIER = 1;
export const MAX_TIER = 4;

/**
 * /epic-acceptance-review Phase 3's severity vocabulary, weakest first — one
 * of the vocabularies `severity_mapping` binds together. Pinned here, next to
 * `CANONICAL_SEVERITIES`, for the same reason that one is: the mapping has to
 * be validated against what the acceptance skill actually emits, not against
 * "some string".
 */
export const ACCEPTANCE_TIERS = ["Minor", "Major", "Blocker"];

/** Linear's priority field domain: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const MIN_LINEAR_PRIORITY = 0;
export const MAX_LINEAR_PRIORITY = 4;

export interface SeverityMappingEntry {
  /** 0-4, Linear's own priority numbering (0 None, 1 Urgent … 4 Low). */
  linearPriority: number;
  /** An `ACCEPTANCE_TIERS` member, or `null` for `unknown`. */
  acceptance: string | null;
}

/** Keyed by reviewer severity token, plus `unknown`. */
export type SeverityMapping = Record<string, SeverityMappingEntry>;

export interface AcceptClauses {
  unconditional?: boolean;
  minSeverity?: string;
  categories?: string[];
  maxTier?: number;
  /** Presence-only, like `unconditional` — there is no meaningful "admit when
   * NOT self-inflicted" clause, so the type (and the loader) only ever admit
   * `true`. */
  selfInflicted?: true;
}

export interface Band {
  id: string;
  fromRound: number;
  /** `null` is open-ended. */
  throughRound: number | null;
  minimalDiff: boolean;
  accept: AcceptClauses;
}

export interface LadderConfig {
  severityOrder: string[];
  /**
   * `null` when the config carries no `severity_mapping` block. Absence is
   * NOT a config error — the ladder never reads this table, so making it
   * load-bearing for ladder liveness would let deleting it silently disarm
   * triage. What makes the SHIPPED file's block mandatory is
   * `__tests__/severity-mapping.test.ts`, which fails closed on a `null`.
   */
  severityMapping: SeverityMapping | null;
  categories: string[];
  inertWhenUnknown: string[];
  bands: Band[];
  marker: string;
  wontFixTemplate: string;
  deferredTemplate: string;
}

export interface LadderInput {
  round: number;
  /** A `severity_order` token, or `unknown`. */
  severity: string;
  /** A `categories` token, or `unknown`. */
  category: string;
  /** Rubric priority tier 1–4, or `null` when not established. */
  tier: number | null;
  /** `self-inflicted.ts`'s answer: `true` / `false` / `null` (not measured). */
  selfInflicted: boolean | null;
}

export interface LadderVerdict {
  config: string;
  round: number;
  band: string | null;
  armed: boolean;
  stance: "accepted" | "declined";
  minimalDiff: boolean;
  /** Clause names that admitted the finding. Empty on a decline. */
  admittedBy: string[];
  /** Clause names that could not be evaluated, with why. */
  abstained: string[];
  /** Clause names the band declares, for the reply macro's `{clauses}`. */
  clauses: string[];
  /** Ready-to-post reply body, or `null` when the stance is `accepted`. */
  reply: string | null;
  /** Fail-open reasons and config complaints. Never silent. */
  anomalies: string[];
}

class ConfigError extends Error {}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`${what} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

/**
 * Reject a mapping key this loader does not know about. A silently-ignored
 * key (a typo'd `min_severty`, say) is dropped without error whenever another
 * clause still admits — indistinguishable from the typo never having been
 * written — which is exactly the "read nothing, report all clear" shape rule
 * 1 of .claude/rules/document-scanning-gates.md exists to close.
 */
function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${what} has unknown key(s): ${unknown.join(", ")} — allowed: ${allowed.join(", ")}`,
    );
  }
}

/** The exact placeholder tokens `render()` ever substitutes. */
const TEMPLATE_PLACEHOLDERS = [
  "marker",
  "config",
  "band",
  "round",
  "severity",
  "category",
  "tier",
  "clauses",
];

/**
 * A brace-delimited token, ANY content — deliberately not restricted to a
 * charset. A charset once widened from `[a-zA-Z_]` to letters/digits/
 * underscore/hyphen still misses a typo written with a space or other
 * punctuation (`{min severity}`), so the only shape that cannot be defeated
 * by the next typo is "starts with `{`, ends with `}`, matches nothing in
 * between" (chatgpt-codex-connector, a reference-implementation pull request round 5). Matching `[^}]*`
 * rather than `+` also catches a bare `{}`, which a `+`-quantified charset
 * let through entirely.
 *
 * The checks below (config-load-time template validation, the
 * `reply.marker` check, and `resolveStance`'s leftover-placeholder guard)
 * all read from this one source rather than each keeping its own copy —
 * independently-maintained placeholder regexes are exactly how this
 * class of finding kept recurring.
 *
 * A plain string, not a `RegExp`: `matchAll` needs the `g` flag, `.test()`/
 * `.match()` must NOT carry it (a shared `g`-flagged `RegExp` object keeps
 * `lastIndex` state between unrelated calls), so each call site builds its
 * own `RegExp` from this source with the flags it needs.
 */
const PLACEHOLDER_SOURCE = "\\{([^}]*)\\}";

/**
 * Every `wont_fix`/`deferred` template's required trailing line, unrendered.
 * Shared between config-load-time validation (`validateLadder`, below) and
 * match-time pattern-building (`ladderDeclinePatterns`) so the two can never
 * silently disagree about what the contract is.
 */
const MARKER_LINE = "<!-- {marker} -->";

/**
 * Reject a template referencing a placeholder `render()` will never
 * substitute — `{severity_typo}` would otherwise survive verbatim into a
 * posted audit reply, since `render()` only replaces the keys it was given
 * and leaves everything else untouched.
 */
function assertKnownPlaceholders(template: string, what: string): void {
  for (const m of template.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))) {
    if (!TEMPLATE_PLACEHOLDERS.includes(m[1] ?? "")) {
      throw new ConfigError(
        `${what} references unknown placeholder {${m[1]}} — allowed: ${TEMPLATE_PLACEHOLDERS.join(", ")}`,
      );
    }
  }
}

/**
 * Shared by every string-vocabulary field (`severity_order`, `categories`,
 * each band's `accept_if.categories`) — shape, non-emptiness, AND per-element
 * sanity, so `categories: ['', security, security]` fails here once rather
 * than silently reaching three different call sites in three different
 * half-checked states.
 */
function asStringList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new ConfigError(`${what} must be a list of strings`);
  }
  if (v.length === 0) throw new ConfigError(`${what} must not be empty`);
  const list = v as string[];
  if (list.some((e) => e.trim() === "")) {
    throw new ConfigError(`${what} must not contain a blank entry`);
  }
  // A padded token (`' security'`) parses fine here but never equals the
  // clean value a real caller passes (`--category security`, or a mechanical
  // classifier's output) — so a padded `categories:` entry and an unpadded
  // `accept_if.categories` entry referencing "the same" token silently
  // create two different vocabulary members, and triage-ladder.ts's
  // `--category` domain check (main(), reads `loaded.config.categories`)
  // stops triage with exit 2 for input that is not actually a typo
  // (chatgpt-codex-connector, a reference-implementation pull request).
  const padded = list.filter((e) => e !== e.trim());
  if (padded.length > 0) {
    throw new ConfigError(
      `${what} must not contain leading/trailing whitespace: ${padded.map((e) => JSON.stringify(e)).join(", ")}`,
    );
  }
  const dupes = duplicatesOf(list);
  if (dupes.length > 0) {
    throw new ConfigError(
      `${what} contains duplicate token(s): ${dupes.join(", ")}`,
    );
  }
  return list;
}

/** The distinct values that occur more than once, in first-seen order. */
function duplicatesOf(list: readonly string[]): string[] {
  return [...new Set(list.filter((e, i) => list.indexOf(e) !== i))];
}

function asTemplate(v: unknown, what: string, token: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ConfigError(`${what} must be a non-empty string`);
  }
  // Mirrors reply-to-thread.ts's `validateOutcomeBody` grammar (the actual
  // post-time check) rather than just the token prefix: `**wont-fix**—
  // {marker}` starts with the token but has no whitespace after it, so it
  // passed a bare `startsWith` check here and then failed validateOutcomeBody
  // on post, breaking the thread-resolution workflow at a live triage
  // decision instead of failing the config at load time. `render()` never
  // rewrites text before the first placeholder, so this first line's grammar
  // is exactly what gets posted.
  const firstLine = v.split("\n", 1)[0] ?? "";
  const rest = firstLine.startsWith(token)
    ? firstLine.slice(token.length)
    : null;
  const m = rest === null ? null : rest.match(/^([ \t]+)(.*)$/);
  if (!m || !/[A-Za-z0-9]/.test(m[2] ?? "")) {
    throw new ConfigError(
      `${what} must open with ${token} followed by whitespace and rationale text`,
    );
  }
  return v;
}

const BAND_KEYS = [
  "id",
  "from_round",
  "through_round",
  "minimal_diff",
  "accept_if",
];
const ACCEPT_IF_KEYS = [
  "unconditional",
  "min_severity",
  "categories",
  "max_tier",
  "self_inflicted",
];

function parseBand(raw: unknown, index: number): Band {
  const b = asRecord(raw, `bands[${index}]`);
  assertKnownKeys(b, BAND_KEYS, `bands[${index}]`);
  const id = b.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ConfigError(`bands[${index}].id must be a non-empty string`);
  }
  // `band.id` is substituted verbatim into every decline reply (`{band}`, see
  // the comment above the uniqueness check below) — a placeholder-shaped id
  // (e.g. `{round}`) reappears in the rendered text looking exactly like an
  // unrendered placeholder, and the SEQUENTIAL substitution order compounds
  // it: `{band}` is filled first, splicing the id's own `{round}` text back
  // into the template, where the later `{round}` substitution then replaces
  // it with the ordinal — attributing the decision to the wrong band. Same
  // check as `reply.marker` below, and the same reason.
  if (new RegExp(PLACEHOLDER_SOURCE).test(id)) {
    throw new ConfigError(
      `bands[${index}].id must not contain placeholder-shaped text like {word} (got ${JSON.stringify(id)}) — it is substituted into the reply templates via {band}, and a placeholder-shaped id defeats the leftover-placeholder guard, corrupting the audit trail`,
    );
  }
  const from = b.from_round;
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 1) {
    throw new ConfigError(`bands[${index}].from_round must be an integer ≥ 1`);
  }
  const through = b.through_round ?? null;
  if (
    through !== null &&
    (typeof through !== "number" ||
      !Number.isSafeInteger(through) ||
      through < from)
  ) {
    throw new ConfigError(
      `bands[${index}].through_round must be null or an integer ≥ from_round`,
    );
  }
  if (typeof b.minimal_diff !== "boolean") {
    throw new ConfigError(`bands[${index}].minimal_diff must be a boolean`);
  }
  const a = asRecord(b.accept_if, `bands[${index}].accept_if`);
  assertKnownKeys(a, ACCEPT_IF_KEYS, `bands[${index}].accept_if`);
  const accept: AcceptClauses = {};
  if (a.unconditional !== undefined) {
    if (a.unconditional !== true) {
      throw new ConfigError(
        `bands[${index}].accept_if.unconditional must be true or absent`,
      );
    }
    accept.unconditional = true;
  }
  if (a.min_severity !== undefined) {
    if (typeof a.min_severity !== "string") {
      throw new ConfigError(
        `bands[${index}].accept_if.min_severity must be a string`,
      );
    }
    accept.minSeverity = a.min_severity;
  }
  if (a.categories !== undefined) {
    accept.categories = asStringList(
      a.categories,
      `bands[${index}].accept_if.categories`,
    );
  }
  if (a.max_tier !== undefined) {
    if (
      typeof a.max_tier !== "number" ||
      !Number.isSafeInteger(a.max_tier) ||
      a.max_tier < MIN_TIER ||
      a.max_tier > MAX_TIER
    ) {
      throw new ConfigError(
        `bands[${index}].accept_if.max_tier must be an integer ${MIN_TIER}-${MAX_TIER} (got ${JSON.stringify(a.max_tier)}) — a value above ${MAX_TIER} would admit every possible tier, silently disabling the band's filtering`,
      );
    }
    accept.maxTier = a.max_tier;
  }
  if (a.self_inflicted !== undefined) {
    if (a.self_inflicted !== true) {
      // Equality-matching `false` would admit every finding MEASURED as not
      // self-inflicted — the opposite of "disabled" a `false` reads as. There
      // is no meaningful "admit when NOT self-inflicted" policy, so this
      // clause is presence-only, exactly like `unconditional` above: delete
      // the line to disable it rather than setting it to `false`.
      throw new ConfigError(
        `bands[${index}].accept_if.self_inflicted must be true or absent`,
      );
    }
    accept.selfInflicted = true;
  }
  // A band with NO clause would decline everything it matched — the exact
  // inversion of this mechanism's fail-open contract, and an easy thing to
  // reach by deleting the last line of an `accept_if`. Refuse the config
  // instead, which sends the whole ladder inert (rule 1 of
  // .claude/rules/document-scanning-gates.md: an input the gate cannot trust
  // is a refusal, not an empty population).
  if (Object.keys(accept).length === 0) {
    throw new ConfigError(
      `bands[${index}].accept_if declares no clause — a band that admits nothing would decline every finding it matched`,
    );
  }
  return {
    id,
    fromRound: from,
    throughRound: through,
    minimalDiff: b.minimal_diff,
    accept,
  };
}

/**
 * Validate an already-parsed config object. Exported so the test suite can
 * assert the SHIPPED file's structure without re-implementing the parse — the
 * census that keeps "read nothing" from reading as "all clear".
 */
/**
 * Parse and validate `severity_mapping` — the one published correspondence
 * between the reviewer severity tokens, /epic-acceptance-review's acceptance
 * tiers, and Linear's priority field (TASK).
 *
 * `undefined` (no block) returns `null` rather than throwing: see
 * `LadderConfig.severityMapping` for why absence must not disarm the ladder.
 * Everything else is strict, because a half-read table is how the
 * vocabularies drifted apart in the first place.
 */
function parseSeverityMapping(
  v: unknown,
  severityOrder: readonly string[],
): SeverityMapping | null {
  if (v === undefined || v === null) return null;
  const root = asRecord(v, "severity_mapping");
  // Exactly the ranked tokens plus `unknown` — no more, no fewer. A missing
  // row makes `SEVERITY_TO_PRIORITY[token]` undefined at the one call site
  // that consumes it, which sends no `priority` at all rather than failing.
  const expected = [...severityOrder, SEVERITY_UNKNOWN];
  const got = Object.keys(root);
  const missing = expected.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !expected.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new ConfigError(
      `severity_mapping must have exactly one row per severity_order token plus '${SEVERITY_UNKNOWN}'` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
    );
  }
  const out: SeverityMapping = {};
  for (const token of expected) {
    const what = `severity_mapping.${token}`;
    const row = asRecord(root[token], what);
    assertKnownKeys(row, ["linear_priority", "acceptance"], what);
    const priority = row.linear_priority;
    // Token-aware, not a single shared `0-4` range: `unknown` is the
    // ABSENCE of a severity (this file's own row comment ties it to
    // Linear's priority 0, "None", one-to-one), so it must be EXACTLY 0 —
    // any other value invents an urgency for a finding nothing ranked at
    // all. Every RANKED severity is the opposite case: TASK exists
    // precisely because an unprioritized ranked follow-up is the measured
    // failure this mapping is supposed to prevent, so it must map to an
    // actual priority, 1-4, never 0. A single shared `0-4` bound let both
    // `low: { linear_priority: 0 }` (unprioritized) and
    // `unknown: { linear_priority: 1 }` (an unranked finding made urgent)
    // validate (round 29).
    const [minPriority, maxPriority] =
      token === SEVERITY_UNKNOWN
        ? [MIN_LINEAR_PRIORITY, MIN_LINEAR_PRIORITY]
        : [MIN_LINEAR_PRIORITY + 1, MAX_LINEAR_PRIORITY];
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < minPriority ||
      priority > maxPriority
    ) {
      throw new ConfigError(
        minPriority === maxPriority
          ? `${what}.linear_priority must be ${minPriority} (got ${JSON.stringify(priority)}) — '${SEVERITY_UNKNOWN}' is the absence of a severity, never an urgency`
          : `${what}.linear_priority must be an integer ${minPriority}-${maxPriority} (got ${JSON.stringify(priority)})`,
      );
    }
    let acceptance: string | null = null;
    if (token === SEVERITY_UNKNOWN) {
      if (row.acceptance !== undefined) {
        throw new ConfigError(
          `${what} must not carry an acceptance tier — '${SEVERITY_UNKNOWN}' is the absence of a severity, and an acceptance gap always has one`,
        );
      }
    } else {
      if (typeof row.acceptance !== "string") {
        throw new ConfigError(`${what}.acceptance must be a string`);
      }
      if (!ACCEPTANCE_TIERS.includes(row.acceptance)) {
        throw new ConfigError(
          `${what}.acceptance must be one of ${ACCEPTANCE_TIERS.join(", ")} (got ${JSON.stringify(row.acceptance)})`,
        );
      }
      acceptance = row.acceptance;
    }
    out[token] = { linearPriority: priority, acceptance };
  }
  // Monotonicity, both directions. Without it the table still parses while
  // saying something incoherent — a `blocker` filed at a LESS urgent Linear
  // priority than a `low`, or ranked below it on the acceptance tier — and
  // every consumer would faithfully reproduce the incoherence.
  for (let i = 1; i < severityOrder.length; i++) {
    const weaker = severityOrder[i - 1] as string;
    const stronger = severityOrder[i] as string;
    const wRow = out[weaker] as SeverityMappingEntry;
    const sRow = out[stronger] as SeverityMappingEntry;
    // Linear priority counts DOWN with urgency (1 Urgent … 4 Low), so a
    // stronger severity must never carry a numerically larger priority.
    if (sRow.linearPriority > wRow.linearPriority) {
      throw new ConfigError(
        `severity_mapping is not monotonic: '${stronger}' is stronger than '${weaker}' but maps to the less urgent Linear priority ${sRow.linearPriority} > ${wRow.linearPriority}`,
      );
    }
    const wTier = ACCEPTANCE_TIERS.indexOf(wRow.acceptance as string);
    const sTier = ACCEPTANCE_TIERS.indexOf(sRow.acceptance as string);
    if (sTier < wTier) {
      throw new ConfigError(
        `severity_mapping is not monotonic: '${stronger}' is stronger than '${weaker}' but maps to the weaker acceptance tier ${sRow.acceptance} < ${wRow.acceptance}`,
      );
    }
  }
  // Row coverage above is one-directional. Every acceptance tier must also
  // be CARRIED by some row, or `acceptancePriority()` returns null for it and
  // Phase 5b files that gap with no priority at all (TASK).
  const carried = new Set(
    Object.values(out)
      .map((e) => e.acceptance)
      .filter((a): a is string => a !== null),
  );
  const unreachable = ACCEPTANCE_TIERS.filter((t) => !carried.has(t));
  if (unreachable.length > 0) {
    throw new ConfigError(
      `severity_mapping leaves acceptance tier(s) with no reviewer token behind them: ${unreachable.join(", ")} — acceptancePriority() returns null for those, and /epic-acceptance-review Phase 5b would file such a gap unprioritized`,
    );
  }
  return out;
}

/**
 * The acceptance -> Linear priority direction, DERIVED from `severity_mapping`
 * rather than published as a second table: the weakest (numerically largest)
 * priority among the reviewer tokens carrying that acceptance tier. That is
 * the read /epic-acceptance-review Phase 5b needs — a gap classified Blocker/
 * Major/Minor with no reviewer token behind it.
 *
 * Returns `null` for a tier no row carries, and for a config with no mapping.
 */
export function acceptancePriority(
  mapping: SeverityMapping | null,
  tier: string,
): number | null {
  if (mapping === null) return null;
  const priorities = Object.values(mapping)
    .filter((e) => e.acceptance === tier)
    .map((e) => e.linearPriority);
  if (priorities.length === 0) return null;
  return Math.max(...priorities);
}

export function validateLadder(doc: unknown): LadderConfig {
  const root = asRecord(doc, "review-triage.yaml");
  // `calibration` is documentation-only (never read below) — allowed but
  // unvalidated, same as the shipped file's own comment describes it.
  assertKnownKeys(
    root,
    [
      "version",
      "severity_order",
      "severity_mapping",
      "categories",
      "fail_open",
      "bands",
      "reply",
      "calibration",
    ],
    "review-triage.yaml",
  );
  if (root.version !== 1) {
    throw new ConfigError(
      `version must be 1 (got ${JSON.stringify(root.version)})`,
    );
  }
  const severityOrder = asStringList(root.severity_order, "severity_order");
  if (severityOrder.includes(SEVERITY_UNKNOWN)) {
    throw new ConfigError(
      `severity_order must not contain '${SEVERITY_UNKNOWN}' — it is the absence of a severity, not a rank`,
    );
  }
  {
    // Duplicates are already refused by asStringList above. The remaining
    // check is not membership alone: `resolveStance` below compares
    // `severityOrder.indexOf(severity) >= severityOrder.indexOf(minSeverity)`,
    // so the config's declared ORDER — not just its set — is load-bearing. A
    // same-membership but reordered list (e.g. `[blocker, high, medium,
    // low]`) would pass a permutation-only check yet invert which findings a
    // `min_severity` clause admits (chatgpt-codex-connector, a reference-implementation pull request): it
    // would make `min_severity: high` admit `medium`/`low` and decline
    // `blocker`. `CANONICAL_SEVERITIES` is itself the one required order
    // (weakest first, matching the shipped config's own comment), so this
    // requires an exact match rather than a looser set check.
    const missing = CANONICAL_SEVERITIES.filter(
      (s) => !severityOrder.includes(s),
    );
    const extra = severityOrder.filter(
      (s) => !CANONICAL_SEVERITIES.includes(s),
    );
    const isCanonicalOrder =
      missing.length === 0 &&
      extra.length === 0 &&
      severityOrder.every((s, i) => s === CANONICAL_SEVERITIES[i]);
    if (!isCanonicalOrder) {
      throw new ConfigError(
        `severity_order must be exactly [${CANONICAL_SEVERITIES.join(", ")}], weakest first (got [${severityOrder.join(", ")}]) — the tokens severityOf (drive-pr/scripts/summary-findings.ts) actually produces, in the order resolveStance's rank comparisons rely on` +
          (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
      );
    }
  }
  const categories = asStringList(root.categories, "categories");
  if (categories.includes(CATEGORY_UNKNOWN)) {
    throw new ConfigError(
      `categories must not contain '${CATEGORY_UNKNOWN}' — it is the absence of a category`,
    );
  }
  // Same defect class as bands[].id and reply.marker above: a category is
  // substituted verbatim into a declined reply via {category}, and a
  // placeholder-shaped category (e.g. `{tier}`) reappears in the rendered
  // text looking like an unrendered placeholder — then the SEQUENTIAL
  // substitution order in render() lets a later key (e.g. `tier`) rewrite
  // that reinjected text, corrupting the audit trail instead of failing open.
  for (const c of categories) {
    if (new RegExp(PLACEHOLDER_SOURCE).test(c)) {
      throw new ConfigError(
        `categories must not contain placeholder-shaped text like {word} (got ${JSON.stringify(c)}) — it is substituted into the reply templates via {category}, and a placeholder-shaped category defeats the leftover-placeholder guard, corrupting the audit trail`,
      );
    }
  }
  const failOpen = asRecord(root.fail_open, "fail_open");
  assertKnownKeys(failOpen, ["inert_when_unknown"], "fail_open");
  const inertWhenUnknown = Array.isArray(failOpen.inert_when_unknown)
    ? failOpen.inert_when_unknown
    : null;
  if (
    inertWhenUnknown === null ||
    inertWhenUnknown.some(
      (e) =>
        e !== "severity" &&
        e !== "category" &&
        e !== "tier" &&
        e !== "self_inflicted",
    )
  ) {
    throw new ConfigError(
      "fail_open.inert_when_unknown must be a list drawn from ['severity', 'category', 'tier', 'self_inflicted']",
    );
  }
  // Not routed through asStringList: an empty list is legitimate here (fail
  // open on nothing), which asStringList's non-empty rule would refuse. The
  // membership check above already guarantees every surviving element is one
  // of the allowed string literals, so the cast is safe.
  const inertWhenUnknownDupes = duplicatesOf(inertWhenUnknown as string[]);
  if (inertWhenUnknownDupes.length > 0) {
    throw new ConfigError(
      `fail_open.inert_when_unknown contains duplicate token(s): ${inertWhenUnknownDupes.join(", ")}`,
    );
  }
  const rawBands = root.bands;
  if (!Array.isArray(rawBands) || rawBands.length === 0) {
    throw new ConfigError("bands must be a non-empty list");
  }
  const bands = rawBands.map(parseBand);
  // Contiguous and ordered, starting at round 1: a gap would silently disarm
  // the ladder for the rounds inside it, and an overlap would make the answer
  // depend on list order rather than on the round.
  let expected = 1;
  for (const [i, band] of bands.entries()) {
    if (band.fromRound !== expected) {
      throw new ConfigError(
        `bands[${i}] '${band.id}' starts at round ${band.fromRound}; the previous band ends at ${expected - 1}, so rounds must resume at ${expected}`,
      );
    }
    if (band.throughRound === null) {
      if (i !== bands.length - 1) {
        throw new ConfigError(
          `bands[${i}] '${band.id}' is open-ended but is not the last band`,
        );
      }
      expected = Number.POSITIVE_INFINITY;
    } else {
      expected = band.throughRound + 1;
    }
  }
  if (expected !== Number.POSITIVE_INFINITY) {
    throw new ConfigError(
      `the last band ends at round ${expected - 1}; the final band must be open-ended (through_round: null) or every later round leaves the ladder inert`,
    );
  }
  // `band.id` is substituted verbatim into every decline reply (`{band}`) and
  // into the calibration record `verification-fit.ts` writes — the only
  // handle either one has on which band actually decided a finding. Two
  // bands sharing an id make both indistinguishable in that output, even
  // though the loader would otherwise treat them as two separate,
  // independently-configured bands.
  const seenIds = new Set<string>();
  for (const band of bands) {
    if (seenIds.has(band.id)) {
      throw new ConfigError(
        `bands[].id must be unique — '${band.id}' is used by more than one band`,
      );
    }
    seenIds.add(band.id);
  }
  for (const band of bands) {
    if (
      band.accept.minSeverity !== undefined &&
      !severityOrder.includes(band.accept.minSeverity)
    ) {
      throw new ConfigError(
        `band '${band.id}' accept_if.min_severity '${band.accept.minSeverity}' is not in severity_order`,
      );
    }
    for (const c of band.accept.categories ?? []) {
      if (!categories.includes(c)) {
        throw new ConfigError(
          `band '${band.id}' accept_if.categories names '${c}', which is not in the categories vocabulary`,
        );
      }
    }
  }
  const reply = asRecord(root.reply, "reply");
  assertKnownKeys(reply, ["marker", "wont_fix", "deferred"], "reply");
  const marker = reply.marker;
  if (typeof marker !== "string" || marker.trim() === "") {
    throw new ConfigError("reply.marker must be a non-empty string");
  }
  // The marker is substituted INTO the templates via {marker}, so a marker
  // that is itself placeholder-shaped (e.g. `{bogus}`) reappears in the
  // rendered text looking exactly like an unrendered placeholder. The
  // leftover-placeholder guard in resolveStance (defense in depth for a
  // stray template placeholder) cannot tell the two apart, so it refuses to
  // post — turning every decline for every band into a silent inert
  // (accepted) verdict. Reject the shape here, at config-load time, same as
  // assertKnownPlaceholders rejects it in the templates themselves.
  if (new RegExp(PLACEHOLDER_SOURCE).test(marker)) {
    throw new ConfigError(
      `reply.marker must not contain placeholder-shaped text like {word} (got ${JSON.stringify(marker)}) — it is substituted into the reply templates, and a marker shaped like a placeholder defeats the leftover-placeholder guard, sending every decline inert instead`,
    );
  }
  const wontFixTemplate = asTemplate(
    reply.wont_fix,
    "reply.wont_fix",
    "**wont-fix**",
  );
  const deferredTemplate = asTemplate(
    reply.deferred,
    "reply.deferred",
    "**deferred**",
  );
  // The trailing `<!-- {marker} -->` line is the ONLY thing
  // `defect-escape.ts --ladder-only` matches on (`ladderDeclinePatterns`), so
  // a template missing it — even one that still mentions `{marker}` in its
  // own prose — produces declines the calibration loop can never find: a
  // silent, permanent hole in the sample the weights are retuned from. A bare
  // `.includes('{marker}')` check passed this test in round 9 (the trailing
  // line was left off, only the prose mentioned it), so this checks the
  // template's own last non-blank line exactly, mirroring what
  // `ladderDeclinePatterns` requires at match time.
  for (const [what, tpl] of [
    ["reply.wont_fix", wontFixTemplate],
    ["reply.deferred", deferredTemplate],
  ] as const) {
    const lines = tpl.split("\n");
    let i = lines.length - 1;
    while (i >= 0 && lines[i]?.trim() === "") i--;
    if (i < 0 || lines[i] !== MARKER_LINE) {
      throw new ConfigError(
        `${what} must end with its own \`${MARKER_LINE}\` line — it is the only handle defect-escape.ts --ladder-only has on a ladder decline (ladderDeclinePatterns matches on that trailing line alone, not the surrounding prose)`,
      );
    }
    // `render()` only ever substitutes TEMPLATE_PLACEHOLDERS; anything else in
    // the template — a typo'd `{severity_typo}` — would otherwise survive
    // verbatim into a posted audit reply.
    assertKnownPlaceholders(tpl, what);
  }
  return {
    severityOrder,
    severityMapping: parseSeverityMapping(root.severity_mapping, severityOrder),
    categories,
    inertWhenUnknown: inertWhenUnknown as string[],
    bands,
    marker,
    wontFixTemplate,
    deferredTemplate,
  };
}

export interface LoadResult {
  config: LadderConfig | null;
  /** Why the config is unusable, when it is. Empty otherwise. */
  anomaly: string;
  /**
   * The `{config}` attribution label for this load: `LADDER_CONFIG_RELPATH`
   * when `path` resolved to that same canonical file, otherwise `path`
   * itself — so a verdict/reply built from an override always names the file
   * that actually produced it, never the canonical one it did not use.
   */
  configLabel: string;
}

/**
 * Read and validate the ladder config. NEVER throws: an unusable config is a
 * `null` with a stated reason, which `resolveStance` turns into an inert
 * (accepted) verdict. `js-yaml` is imported dynamically for the same reason —
 * a skill copy distributed without the repo's dependencies must degrade to
 * "ladder off", not to a module-load crash in every caller.
 */
export async function loadLadder(path: string): Promise<LoadResult> {
  const canonicalAbs = join(consumerRoot(), LADDER_CONFIG_RELPATH);
  const configLabel = path === canonicalAbs ? LADDER_CONFIG_RELPATH : path;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    return {
      config: null,
      anomaly: `${path} could not be read (${code === "" ? String(err) : code})`,
      configLabel,
    };
  }
  let doc: unknown;
  try {
    const { load } = await import("js-yaml");
    doc = load(text);
  } catch (err) {
    return {
      config: null,
      anomaly: `${path} could not be parsed as YAML (${err instanceof Error ? err.message : String(err)})`,
      configLabel,
    };
  }
  try {
    return { config: validateLadder(doc), anomaly: "", configLabel };
  } catch (err) {
    return {
      config: null,
      anomaly: `${path} is not a valid ladder config: ${err instanceof Error ? err.message : String(err)}`,
      configLabel,
    };
  }
}

/** The band whose round range contains `round`, or `null`. Round 0 never matches. */
export function bandFor(config: LadderConfig, round: number): Band | null {
  if (!Number.isSafeInteger(round) || round < 1) return null;
  for (const band of config.bands) {
    if (round < band.fromRound) continue;
    if (band.throughRound === null || round <= band.throughRound) return band;
  }
  return null;
}

/** Human-readable clause list, for the reply macro's `{clauses}`. */
function clauseNames(accept: AcceptClauses): string[] {
  const out: string[] = [];
  if (accept.unconditional) out.push("unconditional");
  if (accept.minSeverity !== undefined)
    out.push(`min_severity=${accept.minSeverity}`);
  if (accept.categories !== undefined)
    out.push(`categories=[${accept.categories.join(", ")}]`);
  if (accept.maxTier !== undefined) out.push(`max_tier=${accept.maxTier}`);
  if (accept.selfInflicted) out.push("self_inflicted=true");
  return out;
}

/**
 * Substitute every placeholder in ONE non-rescanning pass.
 *
 * The obvious implementation — a loop of `replaceAll('{key}', value)` per
 * key — is multi-pass, so text a value INSERTS is re-read as template syntax
 * by every later iteration. `{config}` is the reachable vector, because its
 * value is an operator-supplied path (`--config`, or
 * `$GROUNDWORK_REVIEW_TRIAGE_CONFIG`): a config at `/tmp/{round}/review-triage.yaml`
 * had its injected `{round}` rewritten to the finding's round, silently
 * misattributing the decline to a file that does not exist; a path containing
 * an unknown token like `{trial}` instead survived to `resolveStance`'s
 * leftover-placeholder guard and turned a VALID decline inert (coderabbitai +
 * chatgpt-codex-connector, a reference-implementation pull request round 17 — both reviewers, independently,
 * on the same root cause).
 *
 * One `replaceAll` over `PLACEHOLDER_SOURCE` with a FUNCTION replacer fixes
 * the class rather than the instance: a function replacer's return value is
 * never rescanned, and — unlike a string replacement — `$&`/`$1` inside a
 * value are literal rather than expansion syntax, so a path containing them
 * survives verbatim too.
 *
 * An unknown token is returned UNCHANGED and REPORTED in `unrendered`.
 * Reporting it is the load-bearing half: the leftover-placeholder guard used
 * to re-scan the rendered OUTPUT for `{...}`, which cannot distinguish a
 * template placeholder that failed to substitute from brace text that arrived
 * inside a substituted VALUE — so an operator config at
 * `/tmp/a{trial}b/review-triage.yaml` tripped the guard and turned a valid
 * decline inert (the second half of the same round-17 finding). "Did the
 * TEMPLATE carry a placeholder I could not fill" is only answerable during
 * substitution; the output string no longer has the information.
 */
function render(
  template: string,
  values: Record<string, string | number>,
): { text: string; unrendered: string[] } {
  const unrendered: string[] = [];
  const text = template.replaceAll(
    new RegExp(PLACEHOLDER_SOURCE, "g"),
    (whole: string, key: string) => {
      const v = values[key];
      if (v === undefined) {
        unrendered.push(whole);
        return whole;
      }
      return String(v);
    },
  );
  return { text, unrendered };
}

/**
 * Resolve one otherwise-`accepted` finding against the ladder.
 *
 * `obligatory` picks which macro a decline gets: the deferral batch when the
 * work must eventually happen, `wont-fix` when it merely could. That boundary
 * is the rubric's, unchanged — the ladder decides WHETHER to decline, never
 * whether the residue is obligatory.
 */
export function resolveStance(
  loaded: LoadResult,
  input: LadderInput,
  obligatory: boolean,
): LadderVerdict {
  const inert = (anomalies: string[], band: string | null): LadderVerdict => ({
    config: loaded.configLabel,
    round: input.round,
    band,
    armed: false,
    stance: "accepted",
    minimalDiff: false,
    admittedBy: [],
    abstained: [],
    clauses: [],
    reply: null,
    anomalies,
  });

  const config = loaded.config;
  if (config === null) {
    return inert(
      [`${loaded.anomaly} — the ladder does not arm this pass`],
      null,
    );
  }

  for (const name of config.inertWhenUnknown) {
    const missing =
      (name === "severity" && input.severity === SEVERITY_UNKNOWN) ||
      (name === "category" && input.category === CATEGORY_UNKNOWN) ||
      (name === "tier" && input.tier === null) ||
      (name === "self_inflicted" && input.selfInflicted === null);
    if (missing) {
      return inert(
        [
          `${name} is unknown and is listed in fail_open.inert_when_unknown — the ladder does not arm for this finding`,
        ],
        null,
      );
    }
  }

  const band = bandFor(config, input.round);
  if (band === null) {
    return inert(
      [
        input.round < 1
          ? "round 0 — no loop has counted a round for this PR, so the ladder does not arm (current-round.ts explains the three ways to get it)"
          : `round ${input.round} falls in no band — the ladder does not arm`,
      ],
      null,
    );
  }

  const anomalies: string[] = [];
  const admittedBy: string[] = [];
  const abstained: string[] = [];
  const accept = band.accept;

  if (accept.unconditional) admittedBy.push("unconditional");

  if (accept.minSeverity !== undefined) {
    const rank = config.severityOrder.indexOf(input.severity);
    const floor = config.severityOrder.indexOf(accept.minSeverity);
    if (rank === -1) {
      // Reached only when `severity` is NOT on the inert list — an explicit
      // fail_open choice — or when the caller passed a token outside the
      // vocabulary. Either way it abstains rather than admitting: the clause
      // cannot be shown to hold.
      abstained.push(
        `min_severity (severity '${input.severity}' is not in severity_order)`,
      );
    } else if (rank >= floor) {
      admittedBy.push(
        `min_severity (${input.severity} ≥ ${accept.minSeverity})`,
      );
    }
  }

  if (accept.categories !== undefined) {
    if (input.category === CATEGORY_UNKNOWN) {
      abstained.push("categories (category is unknown)");
    } else if (!config.categories.includes(input.category)) {
      abstained.push(
        `categories (category '${input.category}' is not in the vocabulary)`,
      );
    } else if (accept.categories.includes(input.category)) {
      admittedBy.push(`categories (${input.category})`);
    }
  }

  if (accept.maxTier !== undefined) {
    if (input.tier === null) {
      abstained.push("max_tier (tier was not established)");
    } else if (input.tier <= accept.maxTier) {
      admittedBy.push(`max_tier (tier ${input.tier} ≤ ${accept.maxTier})`);
    }
  }

  if (accept.selfInflicted) {
    if (input.selfInflicted === null) {
      // `null` is NOT `false` — self-inflicted.ts says so itself. The clause
      // abstains, which is the strict direction for THIS clause, so it is
      // surfaced loudly: an unmeasured anchor is exactly the case where a
      // regression from this PR's own round fix gets declined.
      abstained.push("self_inflicted (not measured — null, not false)");
      anomalies.push(
        "self-inflicted was not measured for this finding; the clause that keeps a regression from this PR's own earlier round accepted could not fire. Re-run self-inflicted.ts before trusting a decline.",
      );
    } else if (input.selfInflicted === true) {
      admittedBy.push("self_inflicted (true)");
    }
    // input.selfInflicted === false never admits — there is no "not
    // self-inflicted" clause, only presence of the measured-true one.
  }

  const clauses = clauseNames(accept);
  if (admittedBy.length > 0) {
    return {
      config: loaded.configLabel,
      round: input.round,
      band: band.id,
      armed: true,
      stance: "accepted",
      minimalDiff: band.minimalDiff,
      admittedBy,
      abstained,
      clauses,
      reply: null,
      anomalies,
    };
  }

  const template = obligatory
    ? config.deferredTemplate
    : config.wontFixTemplate;
  const { text: rendered, unrendered } = render(template, {
    marker: config.marker,
    config: loaded.configLabel,
    band: band.id,
    round: input.round,
    severity: input.severity,
    category: input.category,
    tier: input.tier === null ? "unknown" : input.tier,
    clauses: clauses.join("; "),
  });
  // Defense in depth behind assertKnownPlaceholders (config-load time): a
  // stray `{...}` the TEMPLATE carried and render() could not fill means
  // validation missed something, and posting it verbatim would ship broken
  // text to a PR rather than merely mis-triage a finding — so this refuses to
  // post, not just warn.
  //
  // Read off render()'s own report, NEVER by re-scanning `rendered`: a
  // substituted VALUE can legitimately contain brace text (an operator's
  // `--config /tmp/a{trial}b/review-triage.yaml`), and an output scan cannot
  // tell that apart from a template placeholder that failed — it turned a
  // valid decline inert (coderabbitai + chatgpt-codex-connector, a reference-implementation pull request
  // round 17).
  if (unrendered.length > 0) {
    return inert(
      [
        `reply macro for band '${band.id}' left placeholder ${unrendered[0]} unrendered — refusing to post a malformed reply`,
      ],
      band.id,
    );
  }
  // `asTemplate` (config-load time) validated this same grammar, but against
  // the RAW template — `{marker}` itself contains letters, so a template like
  // `**wont-fix** {marker}` passes that check even when the substituted
  // `reply.marker` value (e.g. `"---"`) renders a rationale with none. The
  // leftover-placeholder guard just above does not catch this either: the
  // marker fills the placeholder completely, so nothing `{...}`-shaped
  // survives. Re-running the exact `validateOutcomeBody` grammar here, on the
  // RENDERED text, is what actually guarantees the post below succeeds —
  // deliberately a second copy of that grammar rather than an import, for the
  // same standalone-installable reason `validateOutcomeBody`'s own header
  // gives for not sharing code with `/drive-pr` (chatgpt-codex-connector,
  // a reference-implementation pull request).
  const renderedBody = (rendered.split("\n", 1)[0] ?? "")
    .replace(/\r$/, "")
    .match(/^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\*([ \t]+)(.*)$/);
  if (!renderedBody || !/[A-Za-z0-9]/.test(renderedBody[3] ?? "")) {
    return inert(
      [
        `reply macro for band '${band.id}' rendered a body that fails the outcome-reply grammar (validateOutcomeBody) after substitution — refusing to post a malformed reply`,
      ],
      band.id,
    );
  }
  return {
    config: loaded.configLabel,
    round: input.round,
    band: band.id,
    armed: true,
    stance: "declined",
    minimalDiff: band.minimalDiff,
    admittedBy,
    abstained,
    clauses,
    reply: rendered,
    anomalies,
  };
}

/**
 * Absolute path to the shipped config, from this module's own location.
 *
 * `$GROUNDWORK_REVIEW_TRIAGE_CONFIG` overrides it — for a probe of the
 * fail-open/fail-closed paths, and for trialling a retune against a
 * checked-out variant without editing the tracked file. Empty and unset both
 * take the default, the same `${VAR:-def}` semantics `envOrDefault` documents.
 */
export function defaultConfigPath(): string {
  const override = process.env.GROUNDWORK_REVIEW_TRIAGE_CONFIG;
  if (override !== undefined && override.trim() !== "") return override;
  return join(consumerRoot(), LADDER_CONFIG_RELPATH);
}

/**
 * A dedicated trailing `<!-- {marker} -->` line, not the template's own
 * prose — what `defect-escape.ts --ladder-only` actually tests a settled
 * reply against. Two earlier shapes were both defeated:
 *
 *   - a bare `.includes(marker)` counted an ordinary, non-ladder reply that
 *     merely discusses the marker in running prose — e.g. "this predates the
 *     review-triage ladder" (chatgpt-codex-connector, a reference-implementation pull request round 6);
 *   - matching the WHOLE rendered template (wildcarding only its
 *     `{placeholder}`s) fixed that, but tied matching to the templates'
 *     surrounding prose, so rewording `wont_fix`/`deferred` — routine copy
 *     maintenance, `reply.marker` unchanged — silently orphaned every reply
 *     already posted under the old wording, contradicting the config's own
 *     documented contract that only changing the marker does that
 *     (chatgpt-codex-connector, a reference-implementation pull request round 9).
 *
 * Same "own dedicated line, exact match, never a substring" discipline as
 * `hasLeaveOpenMarker` (drive-pr/scripts/lib/outcome.ts): a bare substring
 * search would still count a decline that quotes a full ladder-shaped
 * example later in its body (round 8's gap) or an indented/padded
 * near-match (a markdown blockquote of the marker). `null` (never a guessed
 * default) when the config is unusable: a filter that silently fell back to
 * a hardcoded string would report an empty escape sample as "no escapes",
 * which is rule 1 of `.claude/rules/document-scanning-gates.md` exactly
 * backwards.
 *
 * SCOPE OF THE VERDICT (rule 6, same file; TASK). These patterns decide
 * that a reply ENDS WITH the public marker line. They do NOT decide that
 * `triage-ladder.ts` produced it, and no version of this function can: the
 * marker is text in a GitHub reply body, `settledBody` is the whole of what
 * the caller can see, and any richer "provenance" string persisted into that
 * same body is one more thing a hand-written decline can copy — the decoy
 * moves, it does not disappear. That is rule 3's execution-classification
 * residual: closable only by an explicit scope decision, never by a better
 * recognizer.
 *
 * The decision taken, and what bounds it: the only consumer is
 * `defect-escape.ts --ladder-only`, which narrows a CALIBRATION sample a human
 * reads monthly to retune weights (`.config/review-triage.yaml` §
 * `calibration`). It is not a gate — nothing merges, blocks, or declines on
 * it. The realistic pollution is someone copying the macro's marker line
 * verbatim.
 *
 * Its bias is NOT self-limiting, and the direction is the opposite of the
 * reassuring one, so it is stated rather than assumed. A copied marker
 * inflates the escape rate's DENOMINATOR, making escapes look rarer — and
 * `review-loop-baseline.md` § What this licenses reads a low escape rate as
 * evidence *for* declining more ("evidence for TASK's direction"), while
 * `review-triage.yaml` § `calibration` treats an escape as the signal that a
 * band is too strict. Pollution therefore biases toward TIGHTENING the
 * ladder — declining more work — which is exactly the direction that needs
 * evidence rather than an assumption.
 *
 * So what settles this is a measurement, not an argument about direction.
 *
 * Measured before taking that decision (TASK, 2026-09-05): every merged PR
 * in the window from the ladder's own merge (`d56f6792d2`, 2026-09-02) to
 * 2026-09-05 — 50 PRs, uncapped — yielded 14 marker-carrying declines, and all
 * 14 also carry the macro's rendered prose (`declined by the review-triage
 * ladder (.config/review-triage.yaml, band \`X\`, round N)`). That reading
 * rules out only the narrowest pollution shape — a hand-written decline that
 * appends nothing but the marker line — since this same ratio cannot tell a
 * genuine macro-rendered reply apart from a hand-copied one that reproduces
 * the whole clause (the general limit the next paragraph states in full); it
 * is not evidence the series is unpolluted overall, so the provenance
 * machinery stays unbuilt on this one narrow reading, to be revisited if a
 * later reading disagrees.
 *
 * That check is no longer a one-off: `--ladder-only` reports the same ratio on
 * every run (`LadderScope.macroShaped`), so a series that starts to drift says
 * so at the point of reading rather than at the next audit. It is NOT a bound
 * on pollution in either direction — the same limit `defect-escape.ts`'s own
 * `LadderDisclosure.scopeCaveat` states for this exact ratio: a decline that
 * copied the WHOLE macro clause still counts here, overcounting genuine macro
 * output, while a genuine macro-rendered reply from a config version whose
 * wording has since moved on would not match, undercounting it. It is
 * reported, never filtered on, because filtering on the templates' prose is
 * what round 9 reverted — read it as the spot-check prompt it is, never as
 * proof in either direction.
 *
 * If that monthly read ever observes a polluted series, the fix is a
 * provenance log outside the reply body — `triage-ladder.ts` recording each
 * decline to the `~/.docomply/` JSONL channel `verification-fit.ts` already
 * uses, keyed by thread id + PR, with `--ladder-only` joining against that log
 * instead of the reply text. Until then it is machinery for a hypothetical.
 *
 * `defect-escape.ts` prints this scope on every `--ladder-only` run rather
 * than leaving it here alone, because the reader who over-reads the sample is
 * reading the summary, not this file.
 */
export async function ladderDeclinePatterns(
  path: string = defaultConfigPath(),
): Promise<{
  patterns: RegExp[] | null;
  marker: string | null;
  anomaly: string;
}> {
  const loaded = await loadLadder(path);
  if (loaded.config === null) {
    return { patterns: null, marker: null, anomaly: loaded.anomaly };
  }
  const { marker } = loaded.config;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `(^|\n)` requires the comment to open its own line, never mid-line prose.
  // The trailing `\s*$` requires everything after it to be blank (spaces,
  // tabs, `\r`, further blank lines) — i.e. the marker line is the last
  // NON-BLANK line of the body, mirroring `hasLeaveOpenMarker`'s own
  // trailing-line contract rather than merely "appears somewhere".
  const pattern = new RegExp(`(^|\\n)<!--\\s*${escaped}\\s*-->\\s*$`);
  return { patterns: [pattern], marker, anomaly: "" };
}
