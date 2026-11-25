/**
 * Routing rules: which complexity tier and which effort the implementer of
 * an item runs on, and the model each tier runs on per runtime, as data a
 * repository declares in its `routing` section (design/agent-routing.md in
 * the Jig repository).
 *
 *   routing:                         # absent: routes derived and recorded, none applied
 *     complex_flags: [has-migration] # labels that make an item complex at any size
 *     types:                         # type → its effort, and a tier in place of the table's
 *       feature: { effort: max }
 *     raise:                         # what moves the effort up one step
 *       flags: catalog               # or a list of labels
 *       sizes: [large, xl]           # default: the sizes too large to batch
 *       reviews: true                # an area with a mandatory review
 *     models:                        # runtime → tier → a model the runtime takes
 *       claude-code: { simple: sonnet, standard: sonnet, complex: opus }
 *     model_tiers: {}                # runtime → model → { tier, reason }
 *     family_tiers: {}               # the older spelling of model_tiers
 *     stages: {}                     # stage → models → runtime → tier → model
 *     efforts:                       # runtime → effort → the runtime's own spelling
 *       codex: { max: xhigh }
 *
 * A complexity tier says how hard the item is, never which model runs it:
 * classification selects a tier, and `routing-models.ts` resolves the model
 * separately from the `models` rows, the model-keyed declarations and the
 * per-stage cells.
 * The tier comes from the type and size by `TIER_TABLE`, an explicit
 * `types.<type>.tier` replacing the table's, and a complex flag sets it to
 * `complex` whatever the rest says. `execution` and `strategic`, the tier
 * names of earlier releases, read as `standard` and `complex`.
 */

import { formatField } from "../../../../shared/config-layers.ts";
import { ruleField, ruleList } from "../../../../shared/rule-matcher.ts";
import {
  EFFORTS,
  type Effort,
  effortToken,
  mapping,
  oneOf,
  RoutingError,
  refuseUnknownKeys,
  runtimeKey,
  TIERS,
  type Tier,
  tierNamed,
} from "./routing-fields.ts";
import {
  declaredTiers,
  type FamilyTiers,
  type ModelRow,
  modelAlias,
  parseFamilyTiers,
  parseModels,
  parseModelTiers,
  type Stage,
  type StageModels,
} from "./routing-models.ts";
import {
  type DefaultType,
  isDefaultType,
  UNKNOWN_TYPE,
  type WorkTypes,
} from "./work-types.ts";

export {
  EFFORTS,
  type Effort,
  LEGACY_TIERS,
  RoutingError,
  TIERS,
  type Tier,
  tierNamed,
} from "./routing-fields.ts";
export {
  DEFAULT_MODELS,
  type ModelRow,
  type Stage,
  STAGES,
} from "./routing-models.ts";

/**
 * One type's row: its effort, and the tier it names in place of the
 * table's, `null` where the table decides.
 */
export interface RouteRow {
  tier: Tier | null;
  effort: Effort;
}

export const ROUTE_FIELDS = ["tier", "effort"] as const;

/**
 * M0's ladder applied to the default types: the *what* of a bug, an
 * improvement or a task is known and the job is to execute it; a feature is
 * longer-horizon work; a spike's deliverable is a decision, which is novel
 * reasoning.
 */
export const DEFAULT_EFFORTS: Readonly<Record<DefaultType, Effort>> = {
  bug: "medium",
  feature: "high",
  improvement: "medium",
  task: "low",
  spike: "high",
};

/** The size steps the tier table reads, smallest first. */
export const SIZE_STEPS = ["XS", "S", "M", "L", "XL"] as const;
export type SizeStep = (typeof SIZE_STEPS)[number];

/** The size names each step is read from, ignoring case and a `size:` prefix. */
const SIZE_NAMES: Readonly<Record<string, SizeStep>> = {
  xs: "XS",
  "extra-small": "XS",
  s: "S",
  small: "S",
  m: "M",
  medium: "M",
  l: "L",
  large: "L",
  xl: "XL",
  "x-large": "XL",
  "extra-large": "XL",
  xxl: "XL",
};

/** The size step a size value or label names, or `null` for none. */
export function sizeStep(name: string): SizeStep | null {
  const bare = name
    .trim()
    .toLowerCase()
    .replace(/^size[:/]/, "");
  return Object.hasOwn(SIZE_NAMES, bare) ? (SIZE_NAMES[bare] ?? null) : null;
}

/** A tier at each size step. */
const upTo = (step: SizeStep, lower: Tier, higher: Tier) =>
  Object.fromEntries(
    SIZE_STEPS.map((s) => [
      s,
      SIZE_STEPS.indexOf(s) <= SIZE_STEPS.indexOf(step) ? lower : higher,
    ]),
  ) as Record<SizeStep, Tier>;

/**
 * The complexity table: a bug, an improvement or a feature is standard up
 * to M and complex from L; a task, the mechanical type, is simple up to L
 * and standard at XL; a spike is complex at any size.
 */
export const TIER_TABLE: Readonly<
  Record<DefaultType, Readonly<Record<SizeStep, Tier>>>
> = {
  bug: upTo("M", "standard", "complex"),
  feature: upTo("M", "standard", "complex"),
  improvement: upTo("M", "standard", "complex"),
  task: upTo("L", "simple", "standard"),
  spike: upTo("XL", "complex", "complex"),
};

/** The labels that make an item complex at any size: the sensitivity names `decide` uses. */
export const DEFAULT_COMPLEX_FLAGS = [
  "has-migration",
  "api-change",
  "dpa-relevant",
] as const;

export const ROUTING_FIELDS = [
  "complex_flags",
  "types",
  "raise",
  "models",
  "model_tiers",
  "family_tiers",
  "stages",
  "efforts",
] as const;
export const RAISE_FIELDS = ["flags", "sizes", "reviews"] as const;

/** `routing.raise.flags`: a list of labels, or every flag the catalog declares. */
export type FlagRaise = string[] | "catalog";

export interface RoutingRules {
  /** Whether the repository declares a `routing` section: routes are applied only then. */
  declared: boolean;
  /** Type → its effective row. A type with no row takes `unknownRow`. */
  rows: Record<string, RouteRow>;
  /** The row of an item whose type cannot be derived: the complex tier and the highest effort of any row. */
  unknownRow: { tier: Tier; effort: Effort };
  /** Labels that make an item complex at any size. */
  complexFlags: string[];
  raise: {
    flags: FlagRaise;
    /** `null`: the default, the known sizes too large to batch. */
    sizes: string[] | null;
    reviews: boolean;
  };
  /** Runtime → tier → the runtime's family alias. */
  models: Record<string, ModelRow>;
  /** Stage → runtime → the cells that stage's row sets over `models`. */
  stages: StageModels;
  /** Runtime → model → the M0 tier `model_tiers` and `family_tiers` declare for it. */
  familyTiers: FamilyTiers;
  /** Runtime → effort → the runtime's own name for it, where it differs. */
  efforts: Record<string, Partial<Record<Effort, string>>>;
  /** What the audit reports beside the score: each Judgment mapping and each tier declaration. */
  reported: string[];
}

/** A field written as a list of its one fact's values, read by the rule matcher: the values. */
function ruleValues(value: unknown, field: string): string[] {
  const rule = ruleList(field, value);
  if (!rule.ok) throw new RoutingError(rule.failure.reason);
  if (typeof rule.value === "string")
    throw new RoutingError(`${field} must be a list here`);
  const [fact] = ruleField(field).facts;
  return fact === undefined ? [] : [...(rule.value[fact] ?? [])];
}

/** A tier as written, a legacy name read as the tier it became. */
function tierField(value: unknown, field: string): Tier {
  const tier = tierNamed(value);
  if (tier === undefined)
    throw new RoutingError(
      `${field} must be one of ${TIERS.join(", ")} (execution and strategic read as standard and complex)`,
    );
  return tier;
}

/** One `routing.types` entry, checked against the type set. */
function rowEntry(
  type: string,
  entry: unknown,
  workTypes: WorkTypes,
): Partial<RouteRow> {
  const at = `routing.types.${formatField([type])}`;
  if (type === UNKNOWN_TYPE)
    throw new RoutingError(
      `${at}: the unknown type's row is computed from the others, as the complex tier and the highest effort any row names, and cannot be set`,
    );
  if (!workTypes.types.includes(type))
    throw new RoutingError(
      `${at}: ${type} is not a type of this repository (${workTypes.types.join(", ")}); add it to issue_tracker.types or remove the entry`,
    );
  const fields = mapping(entry, at, "be a mapping of tier and effort");
  refuseUnknownKeys(fields, ROUTE_FIELDS, at);
  const row: Partial<RouteRow> = {};
  if (fields.tier !== undefined)
    row.tier = tierField(fields.tier, `${at}.tier`);
  if (fields.effort !== undefined)
    row.effort = oneOf(fields.effort, EFFORTS, `${at}.effort`);
  return row;
}

/** The effective row of one type, or `undefined` for an added type with none. */
function effectiveRow(
  type: string,
  given: Partial<RouteRow>,
  declared: boolean,
): RouteRow | undefined {
  if (isDefaultType(type))
    return {
      tier: given.tier ?? null,
      effort: given.effort ?? DEFAULT_EFFORTS[type],
    };
  if (given.tier !== undefined && given.effort !== undefined)
    return { tier: given.tier, effort: given.effort };
  // Undeclared routing applies nothing, so a type the repository added
  // takes the strictest row in the record rather than stopping the pickup.
  if (!declared) return undefined;
  throw new RoutingError(
    `routing.types.${formatField([type])}: ${type} is not a default type, so the complexity table has no row for it; set its tier and effort`,
  );
}

/** `routing.types`, each entry checked against the type set. */
function parseRows(
  raw: unknown,
  workTypes: WorkTypes,
  declared: boolean,
): Record<string, RouteRow> {
  const own: Record<string, Partial<RouteRow>> = Object.create(null);
  if (raw !== undefined && raw !== null) {
    const types = mapping(
      raw,
      "routing.types",
      "map a work type to its tier and effort",
    );
    for (const [type, entry] of Object.entries(types))
      own[type] = rowEntry(type, entry, workTypes);
  }
  const rows: Record<string, RouteRow> = Object.create(null);
  for (const type of workTypes.types) {
    const row = effectiveRow(type, own[type] ?? {}, declared);
    if (row !== undefined) rows[type] = row;
  }
  return rows;
}

/**
 * The complex tier and the highest effort any row names, the default rows
 * of the default types included, so an override that lowers one type cannot
 * lower an item whose type is unknown.
 */
function strictestRow(
  rows: Record<string, RouteRow>,
  workTypes: WorkTypes,
): RoutingRules["unknownRow"] {
  const efforts = [
    ...Object.values(rows).map((r) => r.effort),
    ...workTypes.types.filter(isDefaultType).map((t) => DEFAULT_EFFORTS[t]),
  ];
  if (efforts.length === 0) return { tier: "complex", effort: "max" };
  const highest = Math.max(...efforts.map((e) => EFFORTS.indexOf(e)));
  return { tier: "complex", effort: EFFORTS[highest] as Effort };
}

function parseRaise(raw: unknown): RoutingRules["raise"] {
  const out: RoutingRules["raise"] = {
    flags: "catalog",
    sizes: null,
    reviews: true,
  };
  if (raw === undefined || raw === null) return out;
  const raise = mapping(
    raw,
    "routing.raise",
    "be a mapping of flags, sizes and reviews",
  );
  refuseUnknownKeys(raise, RAISE_FIELDS, "routing.raise");
  if (raise.flags !== undefined && raise.flags !== "catalog")
    out.flags = ruleValues(raise.flags, "routing.raise.flags");
  if (raise.sizes !== undefined)
    out.sizes = ruleValues(raise.sizes, "routing.raise.sizes");
  if (raise.reviews !== undefined) {
    if (typeof raise.reviews !== "boolean")
      throw new RoutingError("routing.raise.reviews must be true or false");
    out.reviews = raise.reviews;
  }
  return out;
}

function parseEfforts(raw: unknown): RoutingRules["efforts"] {
  const out: RoutingRules["efforts"] = Object.create(null);
  if (raw === undefined || raw === null) return out;
  const efforts = mapping(
    raw,
    "routing.efforts",
    "map a runtime to its name for each effort",
  );
  for (const [runtime, entry] of Object.entries(efforts)) {
    runtimeKey(runtime, "routing.efforts");
    const at = `routing.efforts.${formatField([runtime])}`;
    const row = mapping(
      entry,
      at,
      `map an effort (${EFFORTS.join(", ")}) to the runtime's name for it`,
    );
    refuseUnknownKeys(row, EFFORTS, at);
    const names: Partial<Record<Effort, string>> = {};
    for (const [effort, name] of Object.entries(row))
      names[effort as Effort] = effortToken(
        name,
        `${at}.${effort}`,
        "the runtime's name for the effort",
      );
    out[runtime] = names;
  }
  return out;
}

/** The section as a mapping, `{}` when undeclared. */
function sectionOf(overlay: Record<string, unknown>): {
  declared: boolean;
  section: Record<string, unknown>;
} {
  const raw = overlay.routing;
  const declared = raw !== undefined && raw !== null;
  const section = declared
    ? mapping(raw, "routing", "be a mapping; routing: {} accepts every default")
    : {};
  return { declared, section };
}

/**
 * The repository's routing rules from a parsed overlay and its work types.
 * Throws, naming the field, on a row for a type outside the type set or for
 * `unknown`, a declared section that leaves a type outside the default list
 * without a complete row, a tier or effort outside the closed lists, a model
 * the known families refuse (`routing-models.ts`), an unknown field, and any
 * value of the wrong shape. An absent section, or one set to null, is
 * undeclared: every default applies and `declared` is false.
 */
export function parseRouting(
  overlay: Record<string, unknown>,
  workTypes: WorkTypes,
): RoutingRules {
  const { declared, section } = sectionOf(overlay);
  refuseUnknownKeys(section, ROUTING_FIELDS, "routing");
  const rows = parseRows(section.types, workTypes, declared);
  const familyTiers = declaredFrom(section);
  const { models, stages, reported } = parseModels(
    section.models,
    familyTiers,
    section.stages,
  );
  return {
    declared,
    rows,
    unknownRow: strictestRow(rows, workTypes),
    complexFlags:
      section.complex_flags === undefined || section.complex_flags === null
        ? [...DEFAULT_COMPLEX_FLAGS]
        : ruleValues(section.complex_flags, "routing.complex_flags"),
    raise: parseRaise(section.raise),
    models,
    stages,
    familyTiers,
    efforts: parseEfforts(section.efforts),
    reported,
  };
}

/** The tiers `routing.model_tiers` and `routing.family_tiers` declare, as one table. */
function declaredFrom(section: Record<string, unknown>): FamilyTiers {
  return declaredTiers(
    parseFamilyTiers(section.family_tiers),
    parseModelTiers(section.model_tiers),
  );
}

/**
 * The tier-to-model table alone (`routing.models` and `routing.stages`,
 * every default applied and every check made), for a reader that resolves a
 * tier without routing an item: the drive's pass model, the steward's. With
 * a `stage`, each cell is the stage's where it sets one, else the
 * all-stages one. Throws, naming the field, as `parseRouting` does.
 */
export function parseRoutingModels(
  overlay: Record<string, unknown>,
  stage?: Stage,
): Record<string, Partial<ModelRow>> {
  const { section } = sectionOf(overlay);
  const parsed = parseModels(
    section.models,
    declaredFrom(section),
    section.stages,
  );
  const runtimes = new Set([
    ...Object.keys(parsed.models),
    ...(stage === undefined ? [] : Object.keys(parsed.stages[stage] ?? {})),
  ]);
  const out: Record<string, Partial<ModelRow>> = Object.create(null);
  for (const runtime of runtimes) {
    const row: Partial<ModelRow> = {};
    for (const tier of TIERS) {
      const alias = modelAlias(parsed, runtime, tier, stage);
      if (alias !== undefined) row[tier] = alias;
    }
    out[runtime] = row;
  }
  return out;
}

/** The labels a declared raise list names that a label taxonomy does not declare. */
export function undeclaredRaiseLabels(
  rules: RoutingRules,
  declares: (label: string) => boolean,
): Array<{ field: string; label: string }> {
  const out: Array<{ field: string; label: string }> = [];
  if (rules.raise.flags !== "catalog")
    for (const label of rules.raise.flags)
      if (!declares(label)) out.push({ field: "routing.raise.flags", label });
  for (const label of rules.raise.sizes ?? [])
    if (!declares(label)) out.push({ field: "routing.raise.sizes", label });
  return out;
}
