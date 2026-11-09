/**
 * `routing.models` and `routing.family_tiers`: the model family each
 * complexity tier runs on per runtime, and the checks the loader makes
 * against the known families (`plugin/shared/model-families.ts`;
 * design/agent-routing.md and ADR-0009 in the Jig repository).
 *
 *   routing:
 *     models:                        # runtime → tier → the runtime's family alias
 *       claude-code: { simple: sonnet, standard: sonnet, complex: opus }
 *       codex: { complex: astra }    # a tier left out keeps its default
 *     family_tiers:                  # a family whose M0 tier differs here
 *       codex: { terra: { tier: strategic, reason: "our provider serves terra-max" } }
 *
 * The loader refuses an alias outside a runtime's known families, any tier
 * mapped to a Scout family (`haiku`, `luna`), which no `family_tiers`
 * entry waives, and a row whose stricter tier runs on a family of a lower
 * M0 tier than a lighter one. A Judgment family (`fable`, `astra`) is no
 * default's, and is accepted where a repository configures it; each such
 * mapping, and each `family_tiers` entry, is reported for the audit.
 */

import { formatField } from "../../../../shared/config-layers.ts";
import {
  familiesOf,
  familyOf,
  familyOfModel,
  M0_TIERS,
  type M0Tier,
} from "../../../../shared/model-families.ts";
import {
  LEGACY_TIERS,
  mapping,
  oneOf,
  RoutingError,
  refuseUnknownKeys,
  runtimeKey,
  TIERS,
  type Tier,
  token,
} from "./routing-fields.ts";

export type ModelRow = Record<Tier, string>;

/** A family's M0 tier as a repository declares it, and why. */
export interface FamilyTier {
  tier: M0Tier;
  reason: string;
}

/** Runtime → family alias → its declared tier. */
export type FamilyTiers = Record<string, Record<string, FamilyTier>>;

/** Each runtime with known families, and the family each tier runs on by default. */
export const DEFAULT_MODELS: Readonly<Record<string, Readonly<ModelRow>>> = {
  "claude-code": { simple: "sonnet", standard: "sonnet", complex: "opus" },
  codex: { simple: "terra", standard: "terra", complex: "sol" },
};

const MODEL_KEYS = [...TIERS, ...Object.keys(LEGACY_TIERS)];
const FAMILY_TIER_FIELDS = ["tier", "reason"] as const;

/** `routing.family_tiers`, each entry with its reason. */
export function parseFamilyTiers(raw: unknown): FamilyTiers {
  const out: FamilyTiers = Object.create(null);
  if (raw === undefined || raw === null) return out;
  const section = mapping(
    raw,
    "routing.family_tiers",
    "map a runtime to the families whose M0 tier it declares",
  );
  for (const [runtime, entry] of Object.entries(section)) {
    runtimeKey(runtime, "routing.family_tiers");
    const at = `routing.family_tiers.${formatField([runtime])}`;
    const families = mapping(
      entry,
      at,
      "map a family alias to its tier and the reason",
    );
    const row: Record<string, FamilyTier> = Object.create(null);
    for (const [family, value] of Object.entries(families)) {
      const field = `${at}.${formatField([family])}`;
      token(family, field, "a family alias");
      const fields = mapping(value, field, "be a mapping of tier and reason");
      refuseUnknownKeys(fields, FAMILY_TIER_FIELDS, field);
      const tier = oneOf(fields.tier, M0_TIERS, `${field}.tier`);
      if (typeof fields.reason !== "string" || fields.reason.trim() === "")
        throw new RoutingError(
          `${field}.reason must say why ${family} is a ${tier} family here; a family's tier is never moved without one`,
        );
      row[family] = { tier, reason: fields.reason.trim() };
    }
    refuseConflictingSpellings(runtime, row);
    out[runtime] = row;
  }
  return out;
}

/** Refuse a runtime's declarations where two spellings of one family name different tiers. */
function refuseConflictingSpellings(
  runtime: string,
  declared: Record<string, FamilyTier>,
): void {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(declared)) {
    const name = canonicalName(runtime, key);
    groups.set(name, [...(groups.get(name) ?? []), key]);
  }
  for (const keys of groups.values()) {
    const tiers = new Set(keys.map((key) => declared[key]?.tier));
    if (tiers.size > 1)
      throw new RoutingError(
        `routing.family_tiers.${formatField([runtime])} declares ${keys.join(", ")}, which are one family, with different tiers; keep one`,
      );
  }
}

/** The tier both a key of this release and its legacy name set, refused where they differ. */
function coalesced(
  named: Record<string, string>,
  tier: Tier,
  at: string,
): string | undefined {
  const legacy = Object.keys(LEGACY_TIERS).find(
    (k) => LEGACY_TIERS[k] === tier,
  );
  const now = named[tier];
  const old = legacy === undefined ? undefined : named[legacy];
  if (now !== undefined && old !== undefined && now !== old)
    throw new RoutingError(
      `${at}.${legacy} (${old}) and ${at}.${tier} (${now}) both name the ${tier} tier's model; keep one`,
    );
  return now ?? old;
}

/** The family aliases a row names, each checked as one word. */
function namedAliases(row: Record<string, unknown>, at: string) {
  const named: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(row))
    named[key] = token(value, `${at}.${key}`, "a family alias");
  return named;
}

/**
 * One runtime's row: legacy keys read as the tiers they became, a legacy
 * `execution` model the fallback of `simple` as of `standard`, then the
 * runtime's defaults; a runtime with no defaults names every tier.
 */
function modelRow(runtime: string, entry: unknown): ModelRow {
  const at = `routing.models.${formatField([runtime])}`;
  const row = mapping(
    entry,
    at,
    `map each tier (${TIERS.join(", ")}) to a family alias`,
  );
  refuseUnknownKeys(row, MODEL_KEYS, at);
  const named = namedAliases(row, at);
  const own: Partial<Record<Tier, string>> = Object.create(null);
  const simple = named.simple ?? named.execution;
  if (simple !== undefined) own.simple = simple;
  for (const tier of ["standard", "complex"] as const) {
    const alias = coalesced(named, tier, at);
    if (alias !== undefined) own[tier] = alias;
  }
  const given = { ...defaultsOf(runtime), ...own };
  const missing = TIERS.filter((t) => given[t] === undefined);
  if (missing.length > 0)
    throw new RoutingError(
      `${at} must name a family alias for every tier (missing: ${missing.join(", ")})`,
    );
  return given as ModelRow;
}

/** `runtime`'s default row, or none. */
const defaultsOf = (runtime: string): Partial<ModelRow> =>
  Object.hasOwn(DEFAULT_MODELS, runtime) ? { ...DEFAULT_MODELS[runtime] } : {};

/** The alias a `family_tiers` key or a model name stands for: its family's, else itself. */
const canonicalName = (runtime: string, name: string): string =>
  (familyOf(runtime, name) ?? familyOfModel(runtime, name))?.alias ?? name;

/**
 * `runtime`'s declared M0 tier for the family `name` resolves to, or
 * `undefined`. A declaration is read under any spelling of the family, its
 * alias or a model id; `parseFamilyTiers` has refused spellings that
 * disagree, so the first one found speaks for all.
 */
function declaredTier(
  familyTiers: FamilyTiers,
  runtime: string,
  name: string,
): M0Tier | undefined {
  const declared = Object.hasOwn(familyTiers, runtime)
    ? familyTiers[runtime]
    : undefined;
  if (declared === undefined) return undefined;
  const target = canonicalName(runtime, name);
  const key = Object.keys(declared).find(
    (k) => canonicalName(runtime, k) === target,
  );
  return key === undefined ? undefined : declared[key]?.tier;
}

/**
 * The M0 tier the family at `field` runs, `undefined` where nothing names
 * one. The family is resolved once, from its alias or from the model id
 * it names today, and its declaration is read under any spelling of it, so
 * every spelling gets one tier. Refused: a family outside a runtime's known
 * families that `family_tiers` does not declare, a Scout family, however
 * declared, and a model id for a runtime that takes aliases, since its
 * release id would freeze the pin.
 */
function familyTier(
  runtime: string,
  name: string,
  field: string,
  familyTiers: FamilyTiers,
): M0Tier | undefined {
  const known = familiesOf(runtime);
  const byAlias = familyOf(runtime, name);
  const family = byAlias ?? familyOfModel(runtime, name);
  const own = declaredTier(familyTiers, runtime, name);
  if (known !== undefined && family === undefined && own === undefined)
    throw new RoutingError(
      `${field}: ${name} is not a model family ${runtime} knows (${known.families.map((f) => f.alias).join(", ")}); name one, or declare its tier in routing.family_tiers.${runtime}.${name}`,
    );
  if (family?.tier === "scout" || own === "scout")
    throw new RoutingError(
      `${field}: ${name} is a Scout family, which M0 keeps read-only, so it is never a pickup's route and no routing.family_tiers entry changes that (ADR-0009); an implementer may still hand it simple sub-steps`,
    );
  if (
    known?.takesAlias === true &&
    family !== undefined &&
    byAlias === undefined
  )
    throw new RoutingError(
      `${field}: ${name} is a model id, and ${runtime} takes the family alias ${family.alias}; a release id would keep the pin on a superseded model`,
    );
  return own ?? family?.tier;
}

/** Refuse a stricter complexity tier on a family of a lower M0 tier than a lighter one. */
function refuseCheaperStricter(
  row: ModelRow,
  m0: ReadonlyArray<M0Tier | undefined>,
  at: (tier: Tier) => string,
): void {
  TIERS.forEach((stricter, j) => {
    const high = m0[j];
    TIERS.slice(0, j).forEach((lighter, i) => {
      const low = m0[i];
      if (low === undefined || high === undefined) return;
      if (M0_TIERS.indexOf(high) < M0_TIERS.indexOf(low))
        throw new RoutingError(
          `${at(stricter)}: the ${stricter} tier runs on ${row[stricter]} (M0 ${high}), a lower M0 tier than the ${lighter} tier's ${row[lighter]} (M0 ${low}); a stricter complexity tier never runs on a cheaper family`,
        );
    });
  });
}

/**
 * Check one runtime's row against its known families and declared tiers,
 * returning what the audit reports: each tier on a Judgment family.
 */
function checkRow(
  runtime: string,
  row: ModelRow,
  familyTiers: FamilyTiers,
): string[] {
  const at = (tier: Tier) => `routing.models.${formatField([runtime])}.${tier}`;
  const m0 = TIERS.map((tier) =>
    familyTier(runtime, row[tier], at(tier), familyTiers),
  );
  refuseCheaperStricter(row, m0, at);
  return TIERS.filter((_, i) => m0[i] === "judgment").map(
    (tier) =>
      `${at(tier)} runs the ${tier} tier on ${row[tier]}, a Judgment family no default names`,
  );
}

/** The parsed table: each runtime's row, and what the audit reports of it. */
export interface ParsedModels {
  models: Record<string, ModelRow>;
  reported: string[];
}

/**
 * `routing.models` over the defaults, every row (the defaults' included)
 * checked against the known families and `familyTiers`.
 */
export function parseModels(
  raw: unknown,
  familyTiers: FamilyTiers,
): ParsedModels {
  const models: Record<string, ModelRow> = Object.create(null);
  for (const [runtime, row] of Object.entries(DEFAULT_MODELS))
    models[runtime] = { ...row };
  if (raw !== undefined && raw !== null) {
    const section = mapping(
      raw,
      "routing.models",
      "map a runtime to the family alias of each tier",
    );
    for (const [runtime, entry] of Object.entries(section)) {
      runtimeKey(runtime, "routing.models");
      models[runtime] = modelRow(runtime, entry);
    }
  }
  const reported = Object.entries(models).flatMap(([runtime, row]) =>
    checkRow(runtime, row, familyTiers),
  );
  for (const [runtime, families] of Object.entries(familyTiers))
    for (const [family, { tier, reason }] of Object.entries(families))
      reported.push(
        `routing.family_tiers.${formatField([runtime])}.${formatField([family])} reads ${family} as a ${tier} family: ${reason}`,
      );
  return { models, reported };
}
