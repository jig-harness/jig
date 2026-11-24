/**
 * `routing.models`, `routing.model_tiers` (and its older spelling
 * `routing.family_tiers`) and `routing.stages`: the model each complexity
 * tier runs on per runtime, for all stages and for one, and the checks the
 * loader makes against the known families
 * (`plugin/shared/model-families.ts`; design/provider-accounts.md § The
 * open model vocabulary, design/agent-routing.md and ADR-0009 in the Jig
 * repository).
 *
 *   routing:
 *     models:                        # runtime → tier → any model the runtime takes
 *       claude-code: { simple: sonnet, standard: sonnet, complex: opus }
 *       codex: { complex: astra }    # a tier left out keeps its default
 *     model_tiers:                   # a model's M0 tier, where the list does not say
 *       codex: { gpt-house: { tier: strategic, reason: "our gateway's flagship" } }
 *     family_tiers: {}               # read as model_tiers entries
 *     stages:                        # stage → models → runtime → tier → model
 *       steward: { models: { codex: { complex: astra } } }
 *
 * The known families are defaults, not an allowlist: a model outside them
 * is accepted once `model_tiers` says which M0 tier it is, and refused,
 * naming the key to set, before that. The loader also refuses any tier
 * mapped to a Scout model (`haiku`, `luna`), which no entry waives, and a
 * row whose stricter tier runs on a model of a lower M0 tier than a
 * lighter one. A Judgment model (`fable`, `astra`) is no default's, and is
 * accepted where a repository configures it; each such mapping, and each
 * `model_tiers` or `family_tiers` entry, is reported for the audit.
 *
 * The layers merge before this loader reads them, so a stage's row at any
 * layer is more specific than the all-stages row at any layer, and within
 * one the highest layer that sets a cell wins (`modelAlias`).
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
  declarationToken,
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

/** The keys that declare a model's M0 tier, the older spelling second. */
export type TierKey = "model_tiers" | "family_tiers";

/** A model's M0 tier as a repository declares it, and why. */
export interface FamilyTier {
  tier: M0Tier;
  reason: string;
  /** The key that declared it, for the audit's report and the errors. */
  key: TierKey;
}

/** Runtime → model or family alias → its declared tier. */
export type FamilyTiers = Record<string, Record<string, FamilyTier>>;

/** The dispatcher's launch stages, which a `routing.stages` row names. */
export const STAGES = ["pickup", "rearm", "followup", "steward"] as const;
export type Stage = (typeof STAGES)[number];

/** Stage → runtime → the cells the stage's row sets. */
export type StageModels = Record<string, Record<string, Partial<ModelRow>>>;

/** Each runtime with known families, and the family each tier runs on by default. */
export const DEFAULT_MODELS: Readonly<Record<string, Readonly<ModelRow>>> = {
  "claude-code": { simple: "sonnet", standard: "sonnet", complex: "opus" },
  codex: { simple: "terra", standard: "terra", complex: "sol" },
};

const MODEL_KEYS = [...TIERS, ...Object.keys(LEGACY_TIERS)];
const FAMILY_TIER_FIELDS = ["tier", "reason"] as const;

/** `routing.family_tiers`, each entry with its reason. */
export function parseFamilyTiers(raw: unknown): FamilyTiers {
  return parseTierEntries(raw, "family_tiers");
}

/** `routing.model_tiers`, each entry with its reason. */
export function parseModelTiers(raw: unknown): FamilyTiers {
  if (raw === null)
    throw new RoutingError(
      "routing.model_tiers is null, which would erase a lower layer's tier declarations whole; omit the key to inherit, or give a mapping",
    );
  return parseTierEntries(raw, "model_tiers");
}

/**
 * The tiers both keys declare, `model_tiers` and its older spelling read
 * alike. One model declared under both with different tiers is refused,
 * since neither key outranks the other; with one tier, `model_tiers`' reason
 * is kept.
 */
export function declaredTiers(
  familyTiers: FamilyTiers,
  modelTiers: FamilyTiers,
): FamilyTiers {
  const out: FamilyTiers = Object.create(null);
  for (const [runtime, row] of Object.entries(familyTiers))
    out[runtime] = Object.assign(Object.create(null), row);
  for (const [runtime, row] of Object.entries(modelTiers)) {
    const merged: Record<string, FamilyTier> =
      out[runtime] ?? Object.create(null);
    const byModel = new Map<string, string[]>();
    for (const k of Object.keys(merged)) {
      const c = canonicalName(runtime, k);
      byModel.set(c, [...(byModel.get(c) ?? []), k]);
    }
    for (const [name, entry] of Object.entries(row))
      addDeclaration(runtime, merged, byModel, name, entry);
    out[runtime] = merged;
  }
  return out;
}

/**
 * One `model_tiers` entry into a runtime's table, replacing every older-key
 * entry that names the same model under any spelling. `byModel` indexes the
 * table's canonical names once per runtime.
 */
function addDeclaration(
  runtime: string,
  merged: Record<string, FamilyTier>,
  byModel: Map<string, string[]>,
  name: string,
  entry: FamilyTier,
): void {
  const target = canonicalName(runtime, name);
  const olders = byModel.get(target) ?? [];
  for (const older of olders) {
    const other = merged[older];
    if (other === undefined) continue;
    if (other.tier !== entry.tier)
      throw new RoutingError(
        `routing.model_tiers.${formatField([runtime])}.${formatField([name])} (${entry.tier}) and routing.family_tiers.${formatField([runtime])}.${formatField([older])} (${other.tier}) declare one model with different tiers; keep one`,
      );
    // Only an older-key entry is replaced: two `model_tiers` spellings of one
    // model both stay, so the audit reports each declaration's own reason.
    if (other.key !== "model_tiers") delete merged[older];
  }
  merged[name] = entry;
  byModel.set(target, [...olders.filter((k) => k in merged), name]);
}

function parseTierEntries(raw: unknown, key: TierKey): FamilyTiers {
  const out: FamilyTiers = Object.create(null);
  if (raw === undefined || raw === null) return out;
  const section = mapping(
    raw,
    `routing.${key}`,
    "map a runtime to the models whose M0 tier it declares",
  );
  for (const [runtime, entry] of Object.entries(section)) {
    runtimeKey(runtime, `routing.${key}`);
    const at = `routing.${key}.${formatField([runtime])}`;
    const families = mapping(
      entry,
      at,
      "map a model identifier or family alias to its tier and the reason",
    );
    const row: Record<string, FamilyTier> = Object.create(null);
    for (const [family, value] of Object.entries(families)) {
      const field = `${at}.${formatField([family])}`;
      declarationToken(family, field, "a model identifier or family alias");
      const fields = mapping(value, field, "be a mapping of tier and reason");
      refuseUnknownKeys(fields, FAMILY_TIER_FIELDS, field);
      const tier = oneOf(fields.tier, M0_TIERS, `${field}.tier`);
      if (typeof fields.reason !== "string" || fields.reason.trim() === "")
        throw new RoutingError(
          `${field}.reason must say why ${family} is a ${tier} model here; a model's tier is never declared without one`,
        );
      row[family] = { tier, reason: fields.reason.trim(), key };
    }
    refuseConflictingSpellings(runtime, row, key);
    out[runtime] = row;
  }
  return out;
}

/** Refuse a runtime's declarations where two spellings of one family name different tiers. */
function refuseConflictingSpellings(
  runtime: string,
  declared: Record<string, FamilyTier>,
  key: TierKey,
): void {
  const groups = new Map<string, string[]>();
  for (const spelling of Object.keys(declared)) {
    const name = canonicalName(runtime, spelling);
    groups.set(name, [...(groups.get(name) ?? []), spelling]);
  }
  for (const keys of groups.values()) {
    const tiers = new Set(keys.map((key) => declared[key]?.tier));
    if (tiers.size > 1)
      throw new RoutingError(
        `routing.${key}.${formatField([runtime])} declares ${keys.join(", ")}, which are one family, with different tiers; keep one`,
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
 * every spelling gets one tier. Refused: a model outside a runtime's known
 * families that neither declaration key classifies, or a Scout family,
 * however it is declared.
 */
function familyTier(
  runtime: string,
  name: string,
  field: string,
  familyTiers: FamilyTiers,
): M0Tier | undefined {
  const byAlias = familyOf(runtime, name);
  const family = byAlias ?? familyOfModel(runtime, name);
  const own = declaredTier(familyTiers, runtime, name);
  refuseUnlisted(
    runtime,
    name,
    field,
    family !== undefined || own !== undefined,
  );
  if (family?.tier === "scout" || own === "scout")
    throw new RoutingError(
      `${field}: ${name} is a Scout family, which M0 keeps read-only, so it is never a pickup's route and no routing.model_tiers or routing.family_tiers entry changes that (ADR-0009); an implementer may still hand it simple sub-steps`,
    );
  return own ?? family?.tier;
}

/** Refuse a model a runtime with a list does not know and no entry declares. */
function refuseUnlisted(
  runtime: string,
  name: string,
  field: string,
  placed: boolean,
): void {
  const known = familiesOf(runtime);
  if (known === undefined || placed) return;
  throw new RoutingError(
    `${field}: ${name} is not a model ${runtime} knows (${known.families.map((f) => f.alias).join(", ")}); name one of those, or say which M0 tier ${name} is by setting routing.model_tiers.${formatField([runtime])}.${formatField([name])} to { tier: ${M0_TIERS.join(" | ")}, reason }`,
  );
}

/** Refuse a stricter complexity tier on a family of a lower M0 tier than a lighter one. */
function refuseCheaperStricter(
  row: Partial<ModelRow>,
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
  row: Partial<ModelRow>,
  familyTiers: FamilyTiers,
  at: (tier: Tier) => string = (tier) =>
    `routing.models.${formatField([runtime])}.${tier}`,
): string[] {
  const m0 = TIERS.map((tier) => {
    const name = row[tier];
    return name === undefined
      ? undefined
      : familyTier(runtime, name, at(tier), familyTiers);
  });
  refuseCheaperStricter(row, m0, at);
  return TIERS.filter((_, i) => m0[i] === "judgment").map(
    (tier) =>
      `${at(tier)} runs the ${tier} tier on ${row[tier]}, a Judgment family no default names`,
  );
}

/** The parsed table: each runtime's row, the stages' rows, and what the audit reports of them. */
export interface ParsedModels {
  models: Record<string, ModelRow>;
  stages: StageModels;
  reported: string[];
}

const STAGE_FIELDS = ["models"] as const;

/** One stage's row of a runtime: the tiers it sets, each a model, checked as one word. */
function stageRow(entry: unknown, at: string): Partial<ModelRow> {
  const row = mapping(
    entry,
    at,
    `map each tier (${TIERS.join(", ")}) to a model`,
  );
  refuseUnknownKeys(row, TIERS, at);
  const out: Partial<ModelRow> = Object.create(null);
  for (const tier of TIERS) {
    const value = row[tier];
    if (value !== undefined)
      out[tier] = token(value, `${at}.${tier}`, "a model");
  }
  return out;
}

/**
 * `routing.stages`: for each launch stage, the model each runtime's tiers run
 * on there. A stage's cell is more specific than the all-stages cell of
 * `routing.models` and replaces it for that stage, so a cell it leaves out
 * falls through to the all-stages row.
 */
export function parseStages(raw: unknown): StageModels {
  const out: StageModels = Object.create(null);
  if (raw === undefined) return out;
  if (raw === null)
    throw new RoutingError(
      "routing.stages is null, which would erase a lower layer's stage models whole; omit the key to inherit, or give a mapping",
    );
  const section = mapping(
    raw,
    "routing.stages",
    `map a stage (${STAGES.join(", ")}) to its models`,
  );
  refuseUnknownKeys(section, STAGES, "routing.stages");
  for (const [stage, entry] of Object.entries(section)) {
    const at = `routing.stages.${stage}`;
    const fields = mapping(entry, at, "be a mapping with a models field");
    refuseUnknownKeys(fields, STAGE_FIELDS, at);
    if (fields.models === null)
      throw new RoutingError(
        `${at}.models is null, which would erase a lower layer's stage models whole; omit the key to inherit, or give a mapping`,
      );
    const runtimes: Record<string, Partial<ModelRow>> = Object.create(null);
    if (fields.models !== undefined) {
      const models = mapping(
        fields.models,
        `${at}.models`,
        "map a runtime to the model of each tier",
      );
      for (const [runtime, row] of Object.entries(models)) {
        runtimeKey(runtime, `${at}.models`);
        runtimes[runtime] = stageRow(
          row,
          `${at}.models.${formatField([runtime])}`,
        );
      }
    }
    out[stage] = runtimes;
  }
  return out;
}

/**
 * `routing.models` over the defaults, every row (the defaults' included)
 * checked against the known families and the declared tiers, and each
 * stage's cells checked beside the all-stages row they replace.
 */
export function parseModels(
  raw: unknown,
  familyTiers: FamilyTiers,
  stagesRaw?: unknown,
): ParsedModels {
  const models: Record<string, ModelRow> = Object.create(null);
  for (const [runtime, row] of Object.entries(DEFAULT_MODELS))
    models[runtime] = { ...row };
  if (raw !== undefined && raw !== null) {
    const section = mapping(
      raw,
      "routing.models",
      "map a runtime to the model of each tier",
    );
    for (const [runtime, entry] of Object.entries(section)) {
      runtimeKey(runtime, "routing.models");
      models[runtime] = modelRow(runtime, entry);
    }
  }
  const reported = Object.entries(models).flatMap(([runtime, row]) =>
    checkRow(runtime, row, familyTiers),
  );
  const stages = parseStages(stagesRaw);
  for (const [stage, runtimes] of Object.entries(stages))
    for (const [runtime, cells] of Object.entries(runtimes)) {
      const at = (tier: Tier) =>
        `routing.stages.${stage}.models.${formatField([runtime])}.${tier}`;
      // The row the stage runs on: its cells over the all-stages row.
      const effective = { ...models[runtime], ...cells };
      reported.push(
        ...checkRow(runtime, effective, familyTiers, at).filter((line) =>
          TIERS.some((t) => cells[t] !== undefined && line.startsWith(at(t))),
        ),
      );
    }
  for (const [runtime, families] of Object.entries(familyTiers))
    for (const [family, { tier, reason, key }] of Object.entries(families))
      reported.push(
        `routing.${key}.${formatField([runtime])}.${formatField([family])} reads ${family} as a ${tier} family: ${reason}`,
      );
  return { models, stages, reported };
}

/**
 * The model `tier` runs on for `runtime` at `stage`: the stage's cell, else
 * the all-stages one, else `undefined` (a runtime with no row). Layers are
 * already merged, so within each the highest layer that set the cell won.
 */
export function modelAlias(
  parsed: Pick<ParsedModels, "models" | "stages">,
  runtime: string,
  tier: Tier,
  stage?: string,
): string | undefined {
  const own =
    stage !== undefined && Object.hasOwn(parsed.stages, stage)
      ? parsed.stages[stage]
      : undefined;
  const cell =
    own !== undefined && Object.hasOwn(own, runtime)
      ? own[runtime]?.[tier]
      : undefined;
  if (cell !== undefined) return cell;
  return Object.hasOwn(parsed.models, runtime)
    ? parsed.models[runtime]?.[tier]
    : undefined;
}
