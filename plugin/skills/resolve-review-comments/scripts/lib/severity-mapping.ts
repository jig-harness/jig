/**
 * The review-triage file's `severity_mapping`: the one published
 * correspondence between the reviewer severity tokens, an acceptance review's
 * tiers, and the tracker's priority. `ladder.ts` reads it with the rest of
 * the file; the ladder itself never consults it.
 */
import { assertKnownKeys, ConfigError, mappingAt } from "./config-checks.ts";

/** The absence of a severity: a finding no reviewer token ranked. */
export const SEVERITY_UNKNOWN = "unknown";

/**
 * The severity vocabulary an acceptance review classifies a gap with, weakest
 * first — one of the vocabularies `severity_mapping` binds together. The
 * mapping has to be validated against the tiers an acceptance review actually
 * uses, not against "some string".
 */
export const ACCEPTANCE_TIERS = ["Minor", "Major", "Blocker"];

/**
 * The tracker interface's priority domain (`port.ts`): 0 none, 1 urgent,
 * 2 high, 3 medium, 4 low.
 */
const MIN_PRIORITY = 0;
const MAX_PRIORITY = 4;

/** The key a row names its priority with, and the alias also accepted. */
const PRIORITY_KEY = "priority";
const PRIORITY_ALIAS = "linear_priority";

export interface SeverityMappingEntry {
  /** 0-4, the tracker interface's priority numbering (0 none, 1 urgent … 4 low). */
  priority: number;
  /** An `ACCEPTANCE_TIERS` member, or `null` for `unknown`. */
  acceptance: string | null;
}

/** Keyed by reviewer severity token, plus `unknown`. */
export type SeverityMapping = Record<string, SeverityMappingEntry>;

/**
 * Parse and validate `severity_mapping`. A row names its priority
 * `priority`; `linear_priority` is accepted as an alias, and a row may not
 * set both.
 *
 * `undefined` (no block) returns `null` rather than throwing: see
 * `LadderConfig.severityMapping` for why absence must not disarm the ladder.
 * Everything else is strict, because a half-read table is how the
 * vocabularies drifted apart in the first place.
 */
export function parseSeverityMapping(
  v: unknown,
  severityOrder: readonly string[],
): SeverityMapping | null {
  if (v === undefined || v === null) return null;
  const root = mappingAt(v, "severity_mapping");
  const expected = [...severityOrder, SEVERITY_UNKNOWN];
  assertExactRows(Object.keys(root), expected);
  const out: SeverityMapping = {};
  for (const token of expected) {
    const what = `severity_mapping.${token}`;
    const row = mappingAt(root[token], what);
    assertKnownKeys(row, [PRIORITY_KEY, PRIORITY_ALIAS, "acceptance"], what);
    out[token] = {
      priority: rowPriority(row, token, what),
      acceptance: rowAcceptance(row, token, what),
    };
  }
  assertMonotonic(out, severityOrder);
  assertEveryTierCarried(out);
  return out;
}

/**
 * Exactly the ranked tokens plus `unknown` — no more, no fewer. A missing
 * row makes `SEVERITY_TO_PRIORITY[token]` undefined at the one call site
 * that consumes it, which sends no `priority` at all rather than failing.
 */
function assertExactRows(got: string[], expected: string[]): void {
  const missing = expected.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !expected.includes(k));
  if (missing.length === 0 && extra.length === 0) return;
  throw new ConfigError(
    `severity_mapping must have exactly one row per severity_order token plus '${SEVERITY_UNKNOWN}'` +
      (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
      (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
  );
}

/**
 * A row's priority, under `priority` or its alias. Token-aware, not a single
 * shared `0-4` range: `unknown` is the ABSENCE of a severity, so it must be
 * EXACTLY 0 — any other value invents an urgency for a finding nothing
 * ranked at all. Every RANKED severity is the opposite case: an
 * unprioritized ranked follow-up is the failure this mapping exists to
 * prevent, so it must map to an actual priority, 1-4, never 0.
 */
function rowPriority(
  row: Record<string, unknown>,
  token: string,
  what: string,
): number {
  if (row[PRIORITY_KEY] !== undefined && row[PRIORITY_ALIAS] !== undefined)
    throw new ConfigError(
      `${what} sets both ${PRIORITY_KEY} and ${PRIORITY_ALIAS}, its alias; keep ${PRIORITY_KEY}`,
    );
  const named =
    row[PRIORITY_ALIAS] !== undefined ? PRIORITY_ALIAS : PRIORITY_KEY;
  const priority = row[named];
  const unknown = token === SEVERITY_UNKNOWN;
  const [min, max] = unknown
    ? [MIN_PRIORITY, MIN_PRIORITY]
    : [MIN_PRIORITY + 1, MAX_PRIORITY];
  if (
    typeof priority === "number" &&
    Number.isInteger(priority) &&
    priority >= min &&
    priority <= max
  )
    return priority;
  throw new ConfigError(
    unknown
      ? `${what}.${named} must be ${min} (got ${JSON.stringify(priority)}) — '${SEVERITY_UNKNOWN}' is the absence of a severity, never an urgency`
      : `${what}.${named} must be an integer ${min}-${max} (got ${JSON.stringify(priority)})`,
  );
}

/** A ranked row's acceptance tier; `unknown` carries none. */
function rowAcceptance(
  row: Record<string, unknown>,
  token: string,
  what: string,
): string | null {
  if (token === SEVERITY_UNKNOWN) {
    if (row.acceptance === undefined) return null;
    throw new ConfigError(
      `${what} must not carry an acceptance tier — '${SEVERITY_UNKNOWN}' is the absence of a severity, and an acceptance gap always has one`,
    );
  }
  if (typeof row.acceptance !== "string")
    throw new ConfigError(`${what}.acceptance must be a string`);
  if (!ACCEPTANCE_TIERS.includes(row.acceptance))
    throw new ConfigError(
      `${what}.acceptance must be one of ${ACCEPTANCE_TIERS.join(", ")} (got ${JSON.stringify(row.acceptance)})`,
    );
  return row.acceptance;
}

/**
 * Monotonicity, both directions. Without it the table still parses while
 * saying something incoherent — a `blocker` filed at a LESS urgent priority
 * than a `low`, or ranked below it on the acceptance tier — and every
 * consumer would faithfully reproduce the incoherence. Priority counts DOWN
 * with urgency (1 urgent … 4 low), so a stronger severity must never carry a
 * numerically larger priority.
 */
function assertMonotonic(
  out: SeverityMapping,
  severityOrder: readonly string[],
): void {
  for (let i = 1; i < severityOrder.length; i++) {
    const weaker = severityOrder[i - 1] as string;
    const stronger = severityOrder[i] as string;
    const wRow = out[weaker] as SeverityMappingEntry;
    const sRow = out[stronger] as SeverityMappingEntry;
    const pair = `'${stronger}' is stronger than '${weaker}' but maps to the`;
    if (sRow.priority > wRow.priority)
      throw new ConfigError(
        `severity_mapping is not monotonic: ${pair} less urgent priority ${sRow.priority} > ${wRow.priority}`,
      );
    const wTier = ACCEPTANCE_TIERS.indexOf(wRow.acceptance as string);
    const sTier = ACCEPTANCE_TIERS.indexOf(sRow.acceptance as string);
    if (sTier < wTier)
      throw new ConfigError(
        `severity_mapping is not monotonic: ${pair} weaker acceptance tier ${sRow.acceptance} < ${wRow.acceptance}`,
      );
  }
}

/**
 * Row coverage is one-directional. Every acceptance tier must also be
 * CARRIED by some row, or `acceptancePriority()` returns null for it and an
 * acceptance review files that gap with no priority at all.
 */
function assertEveryTierCarried(out: SeverityMapping): void {
  const carried = new Set(
    Object.values(out)
      .map((e) => e.acceptance)
      .filter((a): a is string => a !== null),
  );
  const unreachable = ACCEPTANCE_TIERS.filter((t) => !carried.has(t));
  if (unreachable.length > 0)
    throw new ConfigError(
      `severity_mapping leaves acceptance tier(s) with no reviewer token behind them: ${unreachable.join(", ")} — acceptancePriority() returns null for those, and an acceptance review would file such a gap unprioritized`,
    );
}

/**
 * The acceptance -> priority direction, DERIVED from `severity_mapping`
 * rather than published as a second table: the weakest (numerically largest)
 * priority among the reviewer tokens carrying that acceptance tier. That is
 * the read an acceptance review needs for a gap classified Blocker/Major/Minor
 * with no reviewer token behind it.
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
    .map((e) => e.priority);
  if (priorities.length === 0) return null;
  return Math.max(...priorities);
}
