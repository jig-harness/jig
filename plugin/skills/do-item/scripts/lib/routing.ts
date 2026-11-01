/**
 * Routing rules: which model tier and which effort the implementer of an item
 * runs on, as data a repository declares in its `routing` section
 * (design/agent-routing.md in the Jig repository).
 *
 *   routing:                         # absent: routes derived and recorded, none applied
 *     types:                         # type → its base tier and effort
 *       feature: { effort: max }
 *     raise:                         # what moves the effort up one step
 *       flags: catalog               # or a list of labels
 *       sizes: [large, xl]           # default: the sizes too large to batch
 *       reviews: true                # an area with a mandatory review
 *     models:                        # runtime → tier → the runtime's family alias
 *       claude-code: { execution: sonnet, strategic: opus }
 *     efforts:                       # runtime → effort → the runtime's own spelling
 *       codex: { max: xhigh }
 *
 * The tier is a role, never a model id: `models` is the only place a model
 * name appears. Only the Execution and Strategic tiers can be routed to: an
 * implementer writes, which M0's Scout tier may not, and M0 admits the
 * Judgment tier per decision layer, never by a rule that fires on every item
 * of a type.
 */

import { formatField, isMapping } from "../../../../shared/config-layers.ts";
import { isDistinctNameList } from "../../../../shared/guards.ts";
import {
  type DefaultType,
  isDefaultType,
  UNKNOWN_TYPE,
  type WorkTypes,
} from "./work-types.ts";

/** The tiers a route may name, cheaper first. */
export const TIERS = ["execution", "strategic"] as const;
export type Tier = (typeof TIERS)[number];

/** The efforts a route may name, lowest first. */
export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** One row of the routing table: a type's base tier and effort. */
export interface RouteRow {
  tier: Tier;
  effort: Effort;
}

export const ROUTE_FIELDS = ["tier", "effort"] as const;

/**
 * M0's ladder applied to the default types: the *what* of a bug, an
 * improvement or a task is known and the job is to execute it; a feature is
 * longer-horizon work; a spike's deliverable is a decision, which is novel
 * reasoning.
 */
export const DEFAULT_ROUTE_ROWS: Readonly<
  Record<DefaultType, Readonly<RouteRow>>
> = {
  bug: { tier: "execution", effort: "medium" },
  feature: { tier: "execution", effort: "high" },
  improvement: { tier: "execution", effort: "medium" },
  task: { tier: "execution", effort: "low" },
  spike: { tier: "strategic", effort: "high" },
};

/** The runtime M0's mappings record family aliases for, and its aliases. */
export const DEFAULT_MODELS: Readonly<
  Record<string, Readonly<Record<Tier, string>>>
> = {
  "claude-code": { execution: "sonnet", strategic: "opus" },
};

export const ROUTING_FIELDS = ["types", "raise", "models", "efforts"] as const;
export const RAISE_FIELDS = ["flags", "sizes", "reviews"] as const;

/** `routing.raise.flags`: a list of labels, or every flag the catalog declares. */
export type FlagRaise = string[] | "catalog";

export interface RoutingRules {
  /** Whether the repository declares a `routing` section: routes are applied only then. */
  declared: boolean;
  /** Type → its effective row. A type with no row takes `unknownRow`. */
  rows: Record<string, RouteRow>;
  /** The row of an item whose type cannot be derived: the strictest of every row. */
  unknownRow: RouteRow;
  raise: {
    flags: FlagRaise;
    /** `null`: the default, the known sizes too large to batch. */
    sizes: string[] | null;
    reviews: boolean;
  };
  /** Runtime → tier → the runtime's family alias. */
  models: Record<string, Record<Tier, string>>;
  /** Runtime → effort → the runtime's own name for it, where it differs. */
  efforts: Record<string, Partial<Record<Effort, string>>>;
}

/**
 * A routing setting the loading rules refuse. The message opens with the
 * field at fault, so a caller can name the file or variable that set it.
 */
export class RoutingError extends Error {
  readonly code = "routing_config";
}

/** A runtime name, as `routing.models` and `routing.efforts` key it. */
const RUNTIME_NAME = /^[a-z][a-z0-9_-]*$/;
/** A name a runtime takes: one token, so the route record needs no escaping. */
const TOKEN = /^[^\s,;=]+$/;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined)
    throw new RoutingError(`${field} must be one of ${allowed.join(", ")}`);
  return found;
}

function refuseUnknownKeys(
  section: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(section))
    if (!allowed.includes(key))
      throw new RoutingError(
        `${where}.${formatField([key])} is not a field of ${where} (${allowed.join(", ")})`,
      );
}

function labelList(value: unknown, field: string): string[] {
  if (!isDistinctNameList(value))
    throw new RoutingError(
      `${field} must be a list of distinct nonempty label names`,
    );
  return [...value];
}

function token(value: unknown, field: string, what: string): string {
  if (typeof value !== "string" || !TOKEN.test(value))
    throw new RoutingError(
      `${field} must be ${what}: one word, with no space, comma, semicolon or equals sign`,
    );
  return value;
}

function mapping(
  value: unknown,
  field: string,
  what: string,
): Record<string, unknown> {
  if (!isMapping(value)) throw new RoutingError(`${field} must ${what}`);
  return value;
}

function runtimeKey(runtime: string, field: string): void {
  if (!RUNTIME_NAME.test(runtime))
    throw new RoutingError(
      `${field}.${formatField([runtime])}: a runtime name is lowercase letters, digits, - and _, starting with a letter (claude-code, codex)`,
    );
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
      `${at}: the unknown type's row is computed from the others, as the highest tier and the highest effort any row names, and cannot be set`,
    );
  if (!workTypes.types.includes(type))
    throw new RoutingError(
      `${at}: ${type} is not a type of this repository (${workTypes.types.join(", ")}); add it to issue_tracker.types or remove the entry`,
    );
  const fields = mapping(entry, at, "be a mapping of tier and effort");
  refuseUnknownKeys(fields, ROUTE_FIELDS, at);
  const row: Partial<RouteRow> = {};
  if (fields.tier !== undefined)
    row.tier = oneOf(fields.tier, TIERS, `${at}.tier`);
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
  if (isDefaultType(type)) return { ...DEFAULT_ROUTE_ROWS[type], ...given };
  if (given.tier !== undefined && given.effort !== undefined)
    return given as RouteRow;
  // Undeclared routing applies nothing, so a type the repository added
  // takes the strictest row in the record rather than stopping the pickup.
  if (!declared) return undefined;
  throw new RoutingError(
    `routing.types.${formatField([type])}: ${type} is not a default type, so it has no default row; set its tier and effort`,
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
 * The highest tier and the highest effort any row names, the default rows of
 * the default types included, so an override that lowers one type cannot
 * lower an item whose type is unknown.
 */
function strictestRow(
  rows: Record<string, RouteRow>,
  workTypes: WorkTypes,
): RouteRow {
  const all = [
    ...Object.values(rows),
    ...workTypes.types.filter(isDefaultType).map((t) => DEFAULT_ROUTE_ROWS[t]),
  ];
  const highest = <T extends string>(ladder: readonly T[], values: T[]): T =>
    ladder[Math.max(...values.map((v) => ladder.indexOf(v)))] as T;
  if (all.length === 0) return { tier: "strategic", effort: "max" };
  return {
    tier: highest(
      TIERS,
      all.map((r) => r.tier),
    ),
    effort: highest(
      EFFORTS,
      all.map((r) => r.effort),
    ),
  };
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
    out.flags = labelList(raise.flags, "routing.raise.flags");
  if (raise.sizes !== undefined)
    out.sizes = labelList(raise.sizes, "routing.raise.sizes");
  if (raise.reviews !== undefined) {
    if (typeof raise.reviews !== "boolean")
      throw new RoutingError("routing.raise.reviews must be true or false");
    out.reviews = raise.reviews;
  }
  return out;
}

function parseModels(raw: unknown): RoutingRules["models"] {
  const out: RoutingRules["models"] = Object.create(null);
  for (const [runtime, row] of Object.entries(DEFAULT_MODELS))
    out[runtime] = { ...row };
  if (raw === undefined || raw === null) return out;
  const models = mapping(
    raw,
    "routing.models",
    "map a runtime to the family alias of each tier",
  );
  for (const [runtime, entry] of Object.entries(models)) {
    runtimeKey(runtime, "routing.models");
    const at = `routing.models.${formatField([runtime])}`;
    const row = mapping(
      entry,
      at,
      `map each tier (${TIERS.join(", ")}) to a family alias`,
    );
    refuseUnknownKeys(row, TIERS, at);
    const missing = TIERS.filter((t) => row[t] === undefined);
    if (missing.length > 0)
      throw new RoutingError(
        `${at} must name a family alias for every tier (missing: ${missing.join(", ")})`,
      );
    out[runtime] = {
      execution: token(row.execution, `${at}.execution`, "a family alias"),
      strategic: token(row.strategic, `${at}.strategic`, "a family alias"),
    };
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
      names[effort as Effort] = token(
        name,
        `${at}.${effort}`,
        "the runtime's name for the effort",
      );
    out[runtime] = names;
  }
  return out;
}

/**
 * The repository's routing rules from a parsed overlay and its work types.
 * Throws, naming the field, on a row for a type outside the type set or for
 * `unknown`, a declared section that leaves a type outside the default list
 * without a complete row, a tier or effort outside the closed lists, an
 * unknown field, and any value of the wrong shape. An absent section, or
 * one set to null, is undeclared: every default applies and `declared` is
 * false.
 */
export function parseRouting(
  overlay: Record<string, unknown>,
  workTypes: WorkTypes,
): RoutingRules {
  const raw = overlay.routing;
  const declared = raw !== undefined && raw !== null;
  const section = declared
    ? mapping(raw, "routing", "be a mapping; routing: {} accepts every default")
    : {};
  refuseUnknownKeys(section, ROUTING_FIELDS, "routing");
  const rows = parseRows(section.types, workTypes, declared);
  return {
    declared,
    rows,
    unknownRow: strictestRow(rows, workTypes),
    raise: parseRaise(section.raise),
    models: parseModels(section.models),
    efforts: parseEfforts(section.efforts),
  };
}

/**
 * The tier-to-model table alone (`routing.models`, every default applied),
 * for a reader that resolves a tier without routing an item: the drive's
 * pass model. Throws, naming the field, on a section or a row of the wrong
 * shape, as `parseRouting` does.
 */
export function parseRoutingModels(
  overlay: Record<string, unknown>,
): RoutingRules["models"] {
  const raw = overlay.routing;
  if (raw === undefined || raw === null) return parseModels(undefined);
  const section = mapping(
    raw,
    "routing",
    "be a mapping; routing: {} accepts every default",
  );
  return parseModels(section.models);
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
