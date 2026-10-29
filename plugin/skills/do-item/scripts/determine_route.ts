#!/usr/bin/env bun
/**
 * Derive the route an issue's implementer runs on: the agent, the model tier
 * and the effort, from the issue JSON `get_issue.ts` prints and the
 * consumer's routing rules (`routing`; `lib/routing.ts`).
 *
 * The steps:
 *   1. the agent, exactly as `determine_agent.ts` chooses it;
 *   2. the base tier and effort, from the work type's row
 *      (`determine_type.ts`); `unknown`, and a type with no row, take the
 *      strictest row;
 *   3. the raises, each class moving the effort up one step at most once, in
 *      this order: a flag label, a mandatory review of an area the item's
 *      labels reach, a size too large to batch, the human-in-the-loop label;
 *   4. the cap: an effort raised past `max` stays at `max`, and a raise never
 *      moves the tier;
 *   5. the translation: the tier to the runtime's family alias
 *      (`routing.models`), the effort to the runtime's spelling
 *      (`routing.efforts`).
 * Every part carries the rule that gave it in `reasons`.
 *
 * It prints the proposed route only: whether it was applied is for the
 * delegation to say, and what the implementer ran on is for the runtime to
 * report.
 *
 * Type: Discovery
 * Input: JSON with the issue's `labels`, `title` and `nativeType`
 * Output: JSON `{ agent, type, tier, effort, model, runtime_effort, runtime,
 *   declared, fields, reasons }`
 *
 * Usage:
 *     bun determine_route.ts <issue-json-file>
 *     bun determine_route.ts -          (reads stdin)
 *
 * Exit codes: 0 routed, 2 unreadable input, 1 a configuration the loading
 * rules refuse.
 */

import { existsSync } from "node:fs";
import {
  consumerRoot,
  parseReviewConfig,
  readConfig,
  withSource,
} from "../../../shared/consumer.ts";
import { detectHarness } from "../../../shared/harness.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";
import { applyImpliedClosure } from "../../change-areas/scripts/lib/resolve.ts";
import type { ChangeAreaCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  taxonomyAt,
  taxonomySetting,
} from "../../file-issue/scripts/lib/config.ts";
import { lintTaxonomyFile } from "../../file-issue/scripts/lib/taxonomy.ts";
import { declaresLabel } from "../../file-issue/scripts/lib/validate.ts";
import {
  type AgentRouting,
  catalogPathFromOverlay,
  determineAgents,
  loadCatalog,
  parseAgentRouting,
} from "./determine_agent.ts";
import {
  deriveType,
  type IssueFacts,
  printDerived,
  typeSettings,
} from "./determine_type.ts";
import { runEntry } from "./lib/cli.ts";
import {
  EFFORTS,
  type Effort,
  parseRouting,
  RoutingError,
  type RouteRow,
  type RoutingRules,
  type Tier,
  undeclaredRaiseLabels,
} from "./lib/routing.ts";
import { UNKNOWN_TYPE, type WorkTypes } from "./lib/work-types.ts";

/** A mandatory review the item's labels reach: the area and its skills. */
export interface Review {
  area: string;
  skills: string[];
}

/** What the catalog says about the item, or `null` when a declared catalog cannot be read. */
export interface CatalogFacts {
  /** Every flag the catalog's areas declare. */
  flags: string[];
  /** The mandatory reviews of the areas the item's labels seed, and their `impliedBy` closure. */
  reviews: Review[];
}

/** Everything the derivation reads besides the rules. */
export interface RouteFacts {
  agent: string;
  type: string;
  labels: string[];
  /** `null`: a catalog is declared and cannot be read. */
  catalog: CatalogFacts | null;
  /** `issue_tracker.labels.hitl`. */
  hitl: string;
  /** The size labels the repository knows, batchable or not. */
  knownSizes: string[];
  /** `issue_tracker.labels.batch_sizes`. */
  batchSizes: string[];
  /** The runtime's name (`claude-code`, `codex`), or `null` when none is identified. */
  runtime: string | null;
}

export type Source = "rules" | "person" | "settings" | "pin";

/** One field of a route: what was named in place of the rules, and by whom. */
export interface FieldSource {
  requested: string | null;
  source: Source;
}

export interface Route {
  agent: string;
  type: string;
  tier: Tier;
  effort: Effort;
  /** The tier's family alias for the runtime, or `null` when it has none. */
  model: string | null;
  /** The effort as the runtime spells it. */
  runtime_effort: string;
  runtime: string | null;
  /** Whether the repository declares `routing`: a route is applied only then. */
  declared: boolean;
  fields: { tier: FieldSource; effort: FieldSource; model: FieldSource };
  reasons: string[];
}

const fold = (label: string) => label.trim().toLowerCase();

/**
 * The default size raise: the known sizes outside `batch_sizes`, else
 * `[large]`; a size `batch_sizes` names never raises, the fallback included.
 */
export function defaultRaiseSizes(
  knownSizes: string[],
  batchSizes: string[],
): string[] {
  const batchable = new Set(batchSizes.map(fold));
  const large = knownSizes.filter((s) => !batchable.has(fold(s)));
  if (large.length > 0) return large;
  return batchable.has("large") ? [] : ["large"];
}

/** The first of `labels` that `list` names, ignoring case. */
function firstIn(labels: string[], list: string[]): string | undefined {
  const wanted = new Set(list.map(fold));
  return labels.find((l) => wanted.has(fold(l)));
}

/** Whether `label` is the human-in-the-loop label or one of its facets. */
const isHitl = (label: string, hitl: string) =>
  fold(label) === fold(hitl) || fold(label).startsWith(`${fold(hitl)}:`);

/** The flag raise, or `null`. */
function flagRaise(facts: RouteFacts, rules: RoutingRules): string | null {
  if (rules.raise.flags === "catalog" && facts.catalog === null)
    return "the catalog cannot be read, so its flags are taken to apply";
  const flags =
    rules.raise.flags === "catalog"
      ? (facts.catalog?.flags ?? [])
      : rules.raise.flags;
  // The human-in-the-loop label raises once, in its own class, even where
  // the catalog also lists it as a flag.
  const labels = facts.labels.filter((l) => !isHitl(l, facts.hitl));
  const flag = firstIn(labels, flags);
  return flag === undefined ? null : `flag ${flag}`;
}

/** The mandatory-review raise, or `null`. */
function reviewRaise(facts: RouteFacts, rules: RoutingRules): string | null {
  if (!rules.raise.reviews) return null;
  if (facts.catalog === null)
    return "the catalog cannot be read, so a mandatory review is taken to apply";
  const review = facts.catalog.reviews[0];
  return review === undefined
    ? null
    : `area ${review.area}'s mandatory review (${review.skills.join(", ")})`;
}

/** The size raise, or `null`. */
function sizeRaise(facts: RouteFacts, rules: RoutingRules): string | null {
  const sizes =
    rules.raise.sizes ?? defaultRaiseSizes(facts.knownSizes, facts.batchSizes);
  const size = firstIn(facts.labels, sizes);
  return size === undefined ? null : `size ${size}`;
}

/** The human-in-the-loop raise, or `null`. */
function hitlRaise(facts: RouteFacts): string | null {
  const hitl = facts.labels.find((l) => isHitl(l, facts.hitl));
  return hitl === undefined ? null : `human-in-the-loop label ${hitl}`;
}

/** Each raise that fires, in the order the reasons give them. */
function raises(facts: RouteFacts, rules: RoutingRules): string[] {
  return [
    flagRaise(facts, rules),
    reviewRaise(facts, rules),
    sizeRaise(facts, rules),
    hitlRaise(facts),
  ].filter((r): r is string => r !== null);
}

/** The type's row, or the strictest row, and the reason for it. */
function baseRow(
  facts: RouteFacts,
  rules: RoutingRules,
): { row: RouteRow; base: string } {
  const own = Object.hasOwn(rules.rows, facts.type)
    ? rules.rows[facts.type]
    : undefined;
  if (own !== undefined) return { row: own, base: `type ${facts.type}` };
  return {
    row: rules.unknownRow,
    base:
      facts.type === UNKNOWN_TYPE
        ? "type unknown: the strictest row"
        : `type ${facts.type} has no routing row: the strictest row`,
  };
}

/** The effort after every raise, one step each, stopping at `max`. */
function raisedEffort(
  from: Effort,
  fired: string[],
  reasons: string[],
): Effort {
  const top = EFFORTS.length - 1;
  let step = EFFORTS.indexOf(from);
  for (const raise of fired) {
    const before = EFFORTS[step] as Effort;
    if (step === top) {
      reasons.push(`effort: ${before} (${raise}: already the highest effort)`);
      continue;
    }
    step += 1;
    reasons.push(`effort: ${EFFORTS[step]} (${raise} raised ${before})`);
  }
  return EFFORTS[step] as Effort;
}

/** The tier's family alias for the runtime, or `null`, with the reason. */
function modelFor(
  tier: Tier,
  runtime: string | null,
  rules: RoutingRules,
  reasons: string[],
): string | null {
  if (runtime === null) {
    reasons.push("model: none (no runtime identified)");
    return null;
  }
  const model = Object.hasOwn(rules.models, runtime)
    ? (rules.models[runtime]?.[tier] ?? null)
    : null;
  reasons.push(
    model === null
      ? `model: none (no model for ${runtime})`
      : `model: ${model} (routing.models.${runtime}.${tier})`,
  );
  return model;
}

/** The effort as the runtime spells it, with the reason where it differs. */
function spelledFor(
  effort: Effort,
  runtime: string | null,
  rules: RoutingRules,
  reasons: string[],
): string {
  const spelled =
    runtime === null ? undefined : rules.efforts[runtime]?.[effort];
  if (spelled === undefined) return effort;
  reasons.push(
    `effort: ${spelled} for ${runtime} (routing.efforts.${runtime}.${effort})`,
  );
  return spelled;
}

/** Derive the proposed route from the facts and the rules. */
export function deriveRoute(facts: RouteFacts, rules: RoutingRules): Route {
  const reasons: string[] = [`agent: ${facts.agent} (determine_agent.ts)`];
  const { row, base } = baseRow(facts, rules);
  reasons.push(
    `tier: ${row.tier} (${base})`,
    `effort: ${row.effort} (${base})`,
  );
  const effort = raisedEffort(row.effort, raises(facts, rules), reasons);
  const model = modelFor(row.tier, facts.runtime, rules, reasons);
  const runtimeEffort = spelledFor(effort, facts.runtime, rules, reasons);
  const rulesField = (): FieldSource => ({ requested: null, source: "rules" });
  return {
    agent: facts.agent,
    type: facts.type,
    tier: row.tier,
    effort,
    model,
    runtime_effort: runtimeEffort,
    runtime: facts.runtime,
    declared: rules.declared,
    fields: { tier: rulesField(), effort: rulesField(), model: rulesField() },
    reasons,
  };
}

/** A catalog field the route reads that is malformed: the catalog cannot be used for its facts. */
export class CatalogFieldError extends Error {}

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

// Only an omitted field is absent. A field written with no value reads as
// null, which the catalog's own schema refuses as it refuses any other shape.

/**
 * An area's `impliedBy`: absent is none; any shape but a list of the
 * catalog's area ids refuses, since the closure never follows an id no area
 * has and would drop the review the reference was written to reach.
 */
function impliedByOf(
  key: string,
  value: unknown,
  catalog: ChangeAreaCatalog,
): string[] {
  if (value === undefined) return [];
  if (!isStringList(value))
    throw new CatalogFieldError(
      `areas.${key}.impliedBy must be a list of area ids`,
    );
  const unknown = value.filter((id) => !catalog.has(id));
  if (unknown.length > 0)
    throw new CatalogFieldError(
      `areas.${key}.impliedBy names ${unknown.join(", ")}, which no area of the catalog is`,
    );
  return value;
}

/** An area's `review.skills`: absent is none, any shape but a list of names refuses. */
function reviewSkillsOf(key: string, value: unknown): string[] {
  if (value === undefined) return [];
  const skills =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).skills
      : undefined;
  if (!isStringList(skills))
    throw new CatalogFieldError(
      `areas.${key}.review must be a mapping whose skills is a list of skill names`,
    );
  return skills.filter((s) => s !== "");
}

/**
 * The catalog's flags, and the mandatory reviews of the areas the labels
 * seed through `codearea_areas` and of every area their `impliedBy` closure
 * reaches: the side M3 reads mandatory reviews from. A review is mandatory
 * when the area's `review.skills` names a skill. A malformed `impliedBy` or
 * `review` in any area, or an area id no area has (an `impliedBy` entry, or
 * the `codearea_areas` target of one of the labels), throws
 * `CatalogFieldError` rather than dropping the obligation it carries.
 */
export function catalogFacts(
  catalog: ChangeAreaCatalog,
  labels: string[],
  codeareaAreas: Record<string, string>,
): CatalogFacts {
  const flags = [...new Set([...catalog.values()].flatMap((a) => a.flags))];
  const seeds: string[] = [];
  for (const label of labels) {
    const target = Object.hasOwn(codeareaAreas, fold(label))
      ? codeareaAreas[fold(label)]
      : undefined;
    if (target === undefined) continue;
    if (!catalog.has(target))
      throw new CatalogFieldError(
        `do_item.agents.codearea_areas maps ${label} to ${target}, which no area of the catalog is`,
      );
    seeds.push(target);
  }
  const areas: Record<string, { impliedBy: string[] }> = Object.create(null);
  const skillsOf = new Map<string, string[]>();
  for (const [key, area] of catalog) {
    areas[key] = {
      impliedBy: impliedByOf(key, area.fields.impliedBy, catalog),
    };
    skillsOf.set(key, reviewSkillsOf(key, area.fields.review));
  }
  const reviews: Review[] = [];
  for (const key of [...applyImpliedClosure(seeds, { areas })].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const named = skillsOf.get(key) ?? [];
    if (named.length > 0) reviews.push({ area: key, skills: named });
  }
  return { flags, reviews };
}

/**
 * The size labels the repository knows: `work_batch.sizes`, else the
 * batchable sizes, and the taxonomy's sizes. Only the vocabulary is read:
 * the batching policy (points, budget, ranking) is `work-batch`'s to
 * validate, and a repository that does not batch must still route.
 */
function knownSizes(
  config: Record<string, unknown>,
  batchSizes: string[],
): string[] {
  const section = config.work_batch;
  const declared =
    typeof section === "object" && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>).sizes
      : undefined;
  const review = parseReviewConfig(config.review);
  return [
    ...new Set([
      ...(isStringList(declared) ? declared : batchSizes),
      ...(review.taxonomy?.sizes ?? []),
    ]),
  ];
}

/**
 * Refuse a raise list naming a label the repository's label taxonomy does
 * not declare. A repository without a taxonomy file, or with one its own
 * lint refuses, has nothing to check against here.
 */
function refuseUndeclaredLabels(
  config: Record<string, unknown>,
  rules: RoutingRules,
): void {
  const path = taxonomyAt(consumerRoot(), taxonomySetting(config));
  if (!existsSync(path)) return;
  const taxonomy = lintTaxonomyFile(path).taxonomy;
  if (taxonomy === null) return;
  const undeclared = undeclaredRaiseLabels(rules, (label) =>
    declaresLabel(taxonomy, label),
  );
  const first = undeclared[0];
  if (first !== undefined)
    throw new RoutingError(
      `${first.field} names ${first.label}, which the label taxonomy (${path}) does not declare`,
    );
}

/** The settings the route reads, an error naming the file or variable that set one. */
function readSettings(config: Record<string, unknown>, workTypes: WorkTypes) {
  try {
    const rules = parseRouting(config, workTypes);
    refuseUndeclaredLabels(config, rules);
    const labels = parseTrackerLabels(config);
    return {
      rules,
      agentRouting: parseAgentRouting(config),
      catalogPath: catalogPathFromOverlay(config),
      labels,
      sizes: knownSizes(config, labels.batchSizes),
    };
  } catch (e) {
    throw withSource(
      config,
      ["routing", "do_item", "drive", "issue_tracker", "work_batch", "review"],
      e,
    );
  }
}

/**
 * The catalog's facts for the item: none without a catalog, `null` for a
 * declared one that cannot be read, whose `impliedBy` or `review` is
 * malformed, or that has no area a label's `codearea_areas` target names,
 * which the raises take to apply. Agent routing still uses a
 * catalog its own reader accepts.
 */
function readCatalogFacts(
  catalogPath: string | null,
  issue: IssueFacts,
  agentRouting: AgentRouting,
): { catalog: ChangeAreaCatalog | null; facts: CatalogFacts | null } {
  if (catalogPath === null)
    return { catalog: null, facts: { flags: [], reviews: [] } };
  const { catalog, error } = loadCatalog(catalogPath);
  if (catalog === null) {
    console.error(`Catalog unavailable, raising as if it applied: ${error}`);
    return { catalog: null, facts: null };
  }
  try {
    return {
      catalog,
      facts: catalogFacts(catalog, issue.labels, agentRouting.codeareaAreas),
    };
  } catch (e) {
    if (!(e instanceof CatalogFieldError)) throw e;
    console.error(
      `Catalog unavailable, raising as if it applied: ${e.message}`,
    );
    return { catalog, facts: null };
  }
}

/** The facts and the rules from the configuration, an error naming its source. */
async function readInputs(
  issue: IssueFacts,
): Promise<{ facts: RouteFacts; rules: RoutingRules }> {
  const config = readConfig();
  const { workTypes, titleConvention } = typeSettings(config);
  const verdict = await deriveType(issue, workTypes, titleConvention);
  const settings = readSettings(config, workTypes);
  const { catalog, facts } = readCatalogFacts(
    settings.catalogPath,
    issue,
    settings.agentRouting,
  );
  const agents = determineAgents(
    issue.labels,
    issue.title,
    catalog,
    settings.agentRouting,
  );
  return {
    facts: {
      agent: String(agents.primary_agent),
      type: verdict.type,
      labels: issue.labels,
      catalog: facts,
      hitl: settings.labels.hitl,
      knownSizes: settings.sizes,
      batchSizes: settings.labels.batchSizes,
      runtime: detectHarness()?.name ?? null,
    },
    rules: settings.rules,
  };
}

const main = () =>
  printDerived("determine_route.ts", async (issue) => {
    const { facts, rules } = await readInputs(issue);
    return deriveRoute(facts, rules);
  });

if (import.meta.main) runEntry(main);
