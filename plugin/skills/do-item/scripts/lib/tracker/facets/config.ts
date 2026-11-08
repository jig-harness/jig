/**
 * Where each facet is kept: `issue_tracker.facets`, the stores each adapter
 * can hold, every adapter's default (today's stores), and today's keys read
 * as their facet's form (design/tracker-facets.md in the Jig repository).
 *
 *   issue_tracker:
 *     facets:
 *       type:     { store: native, values: { feature: Story } }
 *       priority: { store: label, labels: { urgent: P0, high: P1, medium: P2, low: P3 } }
 *       size:     { store: field, field: Effort }
 *
 * Reading the section (`parseFacetEntries`) checks what the overlay alone
 * can show; resolving it (`resolveFacets`) adds the type and size values of
 * the repository's label taxonomy and checks the rest. A facet the section
 * leaves out keeps its adapter's default, which is the store it has today:
 * labels for type and size everywhere; priority in labels on GitHub Issues
 * and in the tracker's own priority field on Jira and Linear.
 */

import { existsSync } from "node:fs";
import { isRecord } from "../../../../../../shared/guards.ts";
import { DEFAULT_TRACKER_LABELS } from "../../../../../../shared/tracker-labels.ts";
import { taxonomyAt } from "../../../../../file-issue/scripts/lib/config.ts";
import { lintTaxonomyFile } from "../../../../../file-issue/scripts/lib/taxonomy.ts";
import { TrackerConfigError } from "../config-error.ts";
import {
  FACETS,
  type Facet,
  type FacetStoreKind,
  type FacetStoreReport,
} from "../port.ts";
import {
  canonical,
  DEFAULT_TYPES,
  fold,
  PRIORITY_NAMES,
  type ValueMap,
  valueMap,
} from "./values.ts";

const STORES: ReadonlyArray<FacetStoreKind> = ["native", "field", "label"];
const ENTRY_KEYS = ["store", "values", "field", "labels", "prefix"];

/** The stores each adapter holds in this release, per facet. */
export const ADAPTER_STORES: Readonly<
  Record<string, Readonly<Record<Facet, ReadonlyArray<FacetStoreKind>>>>
> = {
  github: {
    type: ["native", "field", "label"],
    priority: ["native", "field", "label"],
    size: ["field", "label"],
  },
  jira: { type: ["label"], priority: ["native", "label"], size: ["label"] },
  linear: { type: ["label"], priority: ["native", "label"], size: ["label"] },
};

/** Why an adapter cannot hold a store, where the reason is the tracker's. */
const REFUSALS: Readonly<Record<string, string>> = {
  "github native size":
    "an Effort issue field is a field store (store: field, field: Effort)",
  "linear native type": "Linear has no issue types",
  "linear field": "the Linear adapter has no custom field to name",
};

/** One facet's entry in `issue_tracker.facets`, as written. */
export interface FacetEntry {
  store: FacetStoreKind;
  /** `native` and `field`: canonical value → the tracker's value. */
  values?: Record<string, string>;
  /** `field`: the field's name (a GitHub issue field). */
  field?: string;
  /** `label`: canonical value → its label. */
  labels?: Record<string, string>;
  /** `label`: each value's label is this prefix followed by the value. */
  prefix?: string;
}

export type FacetEntries = Partial<Record<Facet, FacetEntry>>;

const at = (facet: string, key?: string) =>
  `issue_tracker.facets.${facet}${key === undefined ? "" : `.${key}`}`;

function textMap(
  v: unknown,
  where: string,
  numbers: boolean,
): Record<string, string> {
  if (!isRecord(v))
    throw new TrackerConfigError(where, `${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    const ok =
      (typeof value === "string" && value.trim() !== "") ||
      (numbers && typeof value === "number" && Number.isFinite(value));
    if (!ok)
      throw new TrackerConfigError(
        `${where}.${key}`,
        `${where}.${key} must be a nonempty ${numbers ? "name or a number" : "label"}`,
      );
    out[key] = String(value);
  }
  return out;
}

function storeOf(facet: Facet, v: unknown, adapter: string): FacetStoreKind {
  const where = at(facet, "store");
  if (!(STORES as readonly unknown[]).includes(v))
    throw new TrackerConfigError(
      where,
      `${where} must be one of ${STORES.join(", ")} (got ${JSON.stringify(v)})`,
    );
  const store = v as FacetStoreKind;
  const held = ADAPTER_STORES[adapter]?.[facet];
  if (held !== undefined && !held.includes(store)) {
    const reason =
      REFUSALS[`${adapter} ${store} ${facet}`] ??
      REFUSALS[`${adapter} ${store}`];
    throw new TrackerConfigError(
      where,
      `${where}: the ${adapter} adapter cannot keep ${facet} in a ${store} store${reason === undefined ? "" : ` (${reason})`}; it keeps ${facet} in ${held.join(" or ")}`,
    );
  }
  return store;
}

/** Refuse a key the store does not take, or a missing one it needs. */
function refuseMisplaced(facet: Facet, e: Record<string, unknown>): void {
  const store = e.store;
  const misplaced = (key: string, stores: string) =>
    new TrackerConfigError(
      at(facet, key),
      `${at(facet, key)} belongs to a ${stores} store, not ${store}`,
    );
  if (store !== "field" && e.field !== undefined)
    throw misplaced("field", "field");
  if (store === "field" && e.field === undefined)
    throw new TrackerConfigError(
      at(facet, "field"),
      `${at(facet, "store")} is field, so ${at(facet, "field")} must name the field`,
    );
  if (store === "label" && e.values !== undefined)
    throw misplaced("values", "native or field");
  if (store !== "label" && e.labels !== undefined)
    throw misplaced("labels", "label");
  if (store !== "label" && e.prefix !== undefined)
    throw misplaced("prefix", "label");
  if (e.labels !== undefined && e.prefix !== undefined)
    throw new TrackerConfigError(
      at(facet, "prefix"),
      `${at(facet, "labels")} and ${at(facet, "prefix")} both say what each value's label is; keep one`,
    );
}

function entryOf(facet: Facet, raw: unknown, adapter: string): FacetEntry {
  if (!isRecord(raw))
    throw new TrackerConfigError(at(facet), `${at(facet)} must be a mapping`);
  const unknown = Object.keys(raw).find((k) => !ENTRY_KEYS.includes(k));
  if (unknown !== undefined)
    throw new TrackerConfigError(
      at(facet, unknown),
      `${at(facet, unknown)} is not a field of a facet (${ENTRY_KEYS.join(", ")})`,
    );
  if (raw.store === undefined)
    throw new TrackerConfigError(
      at(facet, "store"),
      `${at(facet)} must name its store (${STORES.join(", ")}); leave the facet out to keep the adapter's default`,
    );
  const entry: FacetEntry = { store: storeOf(facet, raw.store, adapter) };
  refuseMisplaced(facet, raw);
  if (raw.field !== undefined) {
    if (typeof raw.field !== "string" || raw.field.trim() === "")
      throw new TrackerConfigError(
        at(facet, "field"),
        `${at(facet, "field")} must be a nonempty field name`,
      );
    entry.field = raw.field;
  }
  if (raw.values !== undefined)
    entry.values = textMap(raw.values, at(facet, "values"), true);
  if (raw.labels !== undefined)
    entry.labels = textMap(raw.labels, at(facet, "labels"), false);
  if (raw.prefix !== undefined) {
    if (typeof raw.prefix !== "string" || raw.prefix.trim() === "")
      throw new TrackerConfigError(
        at(facet, "prefix"),
        `${at(facet, "prefix")} must be a nonempty label prefix`,
      );
    entry.prefix = raw.prefix;
  }
  if (facet === "priority") checkPriorityEntry(entry, adapter);
  return entry;
}

/** A priority entry's keys are the priorities, and outside GitHub a label store names its labels. */
function checkPriorityEntry(entry: FacetEntry, adapter: string): void {
  for (const [key, map] of [
    ["values", entry.values],
    ["labels", entry.labels],
  ] as const)
    if (map !== undefined) valueMap(PRIORITY_NAMES, map, at("priority", key));
  if (
    entry.store === "label" &&
    adapter !== "github" &&
    entry.labels === undefined &&
    entry.prefix === undefined
  )
    throw new TrackerConfigError(
      at("priority"),
      `${at("priority")} keeps priority in labels, so it must name them (labels, or a prefix): a ${adapter} label cannot take GitHub's default 'priority: <name>'`,
    );
}

/**
 * `issue_tracker.facets` of an overlay's `issue_tracker` section, checked
 * against what `adapter` can hold. Absent or empty, every facet keeps its
 * default.
 */
export function parseFacetEntries(raw: unknown, adapter: string): FacetEntries {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw))
    throw new TrackerConfigError(
      "issue_tracker.facets",
      "issue_tracker.facets must be a mapping from a facet (type, priority, size) to its store",
    );
  const out: FacetEntries = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(FACETS as readonly string[]).includes(key))
      throw new TrackerConfigError(
        at(key),
        `${at(key)} is not a facet (${FACETS.join(", ")})`,
      );
    out[key as Facet] = entryOf(key as Facet, value, adapter);
  }
  return out;
}

/**
 * The labels a label store gives each value: `labels`, else `prefix` and the
 * value, else `fallback`.
 */
export function entryLabels(
  entry: FacetEntry | undefined,
  value: string,
  fallback: () => string[],
): string[] {
  if (entry?.labels !== undefined) {
    const key = Object.keys(entry.labels).find((k) => fold(k) === fold(value));
    return key === undefined ? [value] : [entry.labels[key] as string];
  }
  if (entry?.prefix !== undefined) return [`${entry.prefix}${value}`];
  return fallback();
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** A facet with a store: where it is kept, and how its values are written there. */
export interface ResolvedFacet {
  facet: Facet;
  store: FacetStoreKind;
  /** Named in the configuration, kept in labels, selected by the GitHub default, or the adapter's default. */
  why: "configured" | "kept in labels" | "detected" | "default";
  /** The canonical values; for priority, its names (`urgent` … `low`). */
  values: string[];
  /** A label store: each value with its labels, the first one written. */
  labels: ReadonlyArray<readonly [string, string[]]> | null;
  /** A field store's field; on GitHub, a native priority is its `Priority` field. */
  field: string | null;
  /** A native or field store's map onto the tracker's values. */
  map: ValueMap | null;
}

/** A facet the repository has no store for, and why. */
export interface NoFacet {
  facet: Facet;
  store: null;
  /** `null`: the repository has no such facet; else why it cannot be read. */
  problem: string | null;
}

export type FacetSlot = ResolvedFacet | NoFacet;

/** Every facet of a repository, resolved. */
export interface Facets {
  adapter: string;
  type: FacetSlot;
  priority: ResolvedFacet;
  size: FacetSlot;
  /** The epic label: an epic needs no size. */
  epic: string;
  /** The taxonomy the values came from, for the report. */
  taxonomy: { path: string | null; problem: string | null };
}

export const usable = (slot: FacetSlot): slot is ResolvedFacet =>
  slot.store !== null;

/** What resolving reads from the tracker configuration. */
export interface FacetInputs {
  adapter: string;
  entries: FacetEntries;
  /** `issue_tracker.types`: work type → the labels that mark it; `null` when unset. */
  types: Record<string, string[]> | null;
  /** `issue_tracker.labels.bug`. */
  bugLabels: string[];
  epic: string;
  /** The GitHub adapter's priority labels in force, and whether today's key set them. */
  priorityLabels: Readonly<Record<string, string>> | null;
  priorityLabelsDeclared: boolean;
  /** The Jira priorities in force (`issue_tracker.jira.priorities`). */
  jiraPriorities: Readonly<Record<string, string>> | null;
  /** Labels a facet's label may not be: the state labels, in labels mode. */
  stateLabels: string[];
}

/** The type and size values a label taxonomy declares. */
export interface TaxonomyValues {
  path: string;
  types: string[];
  /** `null` when the taxonomy has no size group. */
  sizes: string[] | null;
}

/**
 * The type and size values of the taxonomy `setting` names from `root`:
 * `null` when the file does not exist, a problem when it fails its lint.
 */
export function readTaxonomyValues(
  root: string,
  setting: string,
): TaxonomyValues | { path: string; problem: string } | null {
  const path = taxonomyAt(root, setting);
  if (!existsSync(path)) return null;
  const lint = lintTaxonomyFile(path);
  if (lint.taxonomy === null)
    return {
      path,
      problem: `the label taxonomy ${setting} fails its lint (${lint.problems[0] ?? "unreadable"}), so the type and size values are unknown`,
    };
  const size = lint.taxonomy.groups.find((g) => g.id === "size");
  return {
    path,
    types: lint.taxonomy.types,
    sizes: size === undefined ? null : size.labels,
  };
}

/** The work types and their labels: `issue_tracker.types`, or the defaults. */
function workTypeLabels(inputs: FacetInputs): Record<string, string[]> {
  if (inputs.types !== null) return inputs.types;
  return Object.fromEntries(
    DEFAULT_TYPES.map((t) => [
      t,
      t === "bug" ? [...inputs.bugLabels] : [t, `type:${t}`],
    ]),
  );
}

/**
 * The type values and the labels each is kept in by default. With a
 * taxonomy, its types, each the label of its own name and read also from
 * the other labels its work type's entry lists; without one, the work
 * types, each marked by its entry's labels.
 */
function typeDefaults(
  inputs: FacetInputs,
  taxonomy: TaxonomyValues | null,
): { values: string[]; labels: (value: string) => string[] } {
  const work = workTypeLabels(inputs);
  if (taxonomy === null)
    return {
      values: Object.keys(work),
      labels: (v) => [...(work[v] ?? [v])],
    };
  const isType = (l: string) => canonical(taxonomy.types, l) !== null;
  return {
    values: [...taxonomy.types],
    labels: (v) => {
      const own = Object.entries(work).find(([k]) => fold(k) === fold(v));
      const aliases = (own?.[1] ?? []).filter(
        (l) => fold(l) !== fold(v) && !isType(l),
      );
      return [v, ...aliases];
    },
  };
}

function resolved(
  facet: Facet,
  entry: FacetEntry | undefined,
  base: {
    values: string[];
    defaultStore: FacetStoreKind;
    defaultWhy: ResolvedFacet["why"];
    labels: (value: string) => string[];
    nativeField: string | null;
    nativeMap: Record<string, string>;
  },
): ResolvedFacet {
  const store = entry?.store ?? base.defaultStore;
  const why = entry === undefined ? base.defaultWhy : "configured";
  if (store === "label") {
    for (const key of Object.keys(entry?.labels ?? {}))
      if (canonical(base.values, key) === null)
        throw new TrackerConfigError(
          at(facet, "labels"),
          `${at(facet, "labels")} names '${key}', which is not a ${facet} of this repository (${base.values.join(", ")})`,
        );
    return {
      facet,
      store,
      why,
      values: base.values,
      labels: base.values.map(
        (v) => [v, entryLabels(entry, v, () => base.labels(v))] as const,
      ),
      field: null,
      map: null,
    };
  }
  return {
    facet,
    store,
    why,
    values: base.values,
    labels: null,
    field: store === "field" ? (entry?.field ?? null) : base.nativeField,
    map: valueMap(
      base.values,
      entry?.values ?? base.nativeMap,
      at(facet, "values"),
    ),
  };
}

function priorityFacet(inputs: FacetInputs): ResolvedFacet {
  const github = inputs.adapter === "github";
  return resolved("priority", inputs.entries.priority, {
    values: [...PRIORITY_NAMES],
    defaultStore: github ? "label" : "native",
    defaultWhy:
      github && inputs.priorityLabelsDeclared ? "kept in labels" : "default",
    labels: (v) => [
      inputs.priorityLabels?.[v] ?? (github ? `priority: ${v}` : v),
    ],
    nativeField: github ? "Priority" : null,
    nativeMap:
      inputs.adapter === "jira"
        ? { ...(inputs.jiraPriorities ?? {}) }
        : inputs.adapter === "linear"
          ? Object.fromEntries(PRIORITY_NAMES.map((p, i) => [p, String(i + 1)]))
          : {},
  });
}

/**
 * Refuse a label that would set two facts, where a configured facet is one
 * of them: a label of two values, of two facets, or of a facet and a state.
 */
function refuseSharedLabels(
  facets: ResolvedFacet[],
  inputs: FacetInputs,
): void {
  const owner = new Map<string, { who: string; configured: boolean }>();
  for (const s of inputs.stateLabels)
    owner.set(fold(s), { who: "a workflow state", configured: false });
  const claim = (f: Facet, label: string, who: string, configured: boolean) => {
    const other = owner.get(fold(label));
    if (other === undefined) owner.set(fold(label), { who, configured });
    else if (other.who !== who && (configured || other.configured))
      throw new TrackerConfigError(
        at(f),
        `${at(f)} keeps ${who} in the label '${label}', which is also the label of ${other.who}; one label would set two facts`,
      );
  };
  for (const f of facets) {
    const configured = inputs.entries[f.facet] !== undefined;
    for (const [value, labels] of f.labels ?? [])
      for (const label of labels)
        claim(f.facet, label, `${f.facet} ${value}`, configured);
  }
}

/**
 * Refuse type labels named here that `issue_tracker.types`, also set, gives
 * other labels: the two would disagree about which label is a type's.
 */
function refuseDisagreement(
  type: ResolvedFacet,
  today: (value: string) => string[],
  inputs: FacetInputs,
): void {
  const entry = inputs.entries.type;
  if (
    inputs.types === null ||
    entry?.store !== "label" ||
    (entry.labels === undefined && entry.prefix === undefined)
  )
    return;
  for (const [value, labels] of type.labels ?? []) {
    const label = labels[0] as string;
    if (!today(value).some((l) => fold(l) === fold(label)))
      throw new TrackerConfigError(
        at("type"),
        `${at("type")} keeps type ${value} in the label '${label}', but issue_tracker.types marks it with ${today(value).join(", ")}; keep one, or make them agree`,
      );
  }
}

/** The size facet of a readable taxonomy (or none): its size group, kept as labels by default. */
function sizeSlot(inputs: FacetInputs, tax: TaxonomyValues | null): FacetSlot {
  if (tax === null || tax.sizes === null) {
    if (inputs.entries.size !== undefined)
      throw new TrackerConfigError(
        at("size"),
        `${at("size")} names a store, but the repository's label taxonomy has no size group, so there is no size facet`,
      );
    return { facet: "size", store: null, problem: null };
  }
  return resolved("size", inputs.entries.size, {
    values: [...tax.sizes],
    defaultStore: "label",
    defaultWhy: "default",
    labels: (v) => [v],
    nativeField: null,
    nativeMap: {},
  });
}

/**
 * Every facet of a repository from its configuration and its label
 * taxonomy (`null` for none, or the problem that keeps it from being read).
 * Throws, naming the field, on a value map key outside the facet's values,
 * a map that gives two values one tracker value, and a configured facet's
 * label that is also a state's or another facet's.
 */
export function resolveFacets(
  inputs: FacetInputs,
  taxonomy: TaxonomyValues | { path: string; problem: string } | null,
): Facets {
  const broken = taxonomy !== null && "problem" in taxonomy ? taxonomy : null;
  const tax = taxonomy !== null && "types" in taxonomy ? taxonomy : null;
  const defaults = typeDefaults(inputs, tax);
  const { type, size } =
    broken === null
      ? {
          type: typeSlot(inputs, defaults),
          size: sizeSlot(inputs, tax),
        }
      : unreadable(broken.problem);
  const priority = priorityFacet(inputs);
  if (usable(type)) refuseDisagreement(type, defaults.labels, inputs);
  refuseSharedLabels([type, priority, size].filter(usable), inputs);
  return {
    adapter: inputs.adapter,
    type,
    priority,
    size,
    epic: inputs.epic,
    taxonomy: {
      path: taxonomy?.path ?? null,
      problem: broken?.problem ?? null,
    },
  };
}

/** The type facet of a readable taxonomy (or none): labels by default. */
function typeSlot(
  inputs: FacetInputs,
  defaults: ReturnType<typeof typeDefaults>,
): FacetSlot {
  return resolved("type", inputs.entries.type, {
    values: defaults.values,
    defaultStore: "label",
    defaultWhy: inputs.types === null ? "default" : "kept in labels",
    labels: defaults.labels,
    nativeField: null,
    nativeMap: {},
  });
}

/**
 * Type and size when the taxonomy fails its lint: unreadable until repaired.
 * Recovery reads remain available; checkedTracker refuses filing.
 */
function unreadable(problem: string): { type: FacetSlot; size: FacetSlot } {
  return {
    type: { facet: "type", store: null, problem },
    size: { facet: "size", store: null, problem },
  };
}

/**
 * Every facet at its adapter's default, with no taxonomy: what an adapter
 * built without its repository's configuration reads and writes.
 */
export function defaultFacets(
  adapter: string,
  priorityLabels: Readonly<Record<string, string>> | null = null,
): Facets {
  return resolveFacets(
    {
      adapter,
      entries: {},
      types: null,
      bugLabels: [...DEFAULT_TRACKER_LABELS.bug],
      epic: DEFAULT_TRACKER_LABELS.epic,
      priorityLabels,
      priorityLabelsDeclared: false,
      jiraPriorities: null,
      stateLabels: [],
    },
    null,
  );
}

/**
 * How a configured entry names a facet's value: the value itself, or the
 * label of one, ignoring case; an entry that names neither is kept as
 * written. With no such facet, every entry is kept as written, a label.
 */
export function facetValueOf(
  slot: FacetSlot | undefined,
): (entry: string) => string {
  if (slot === undefined || !usable(slot)) return (entry) => entry;
  return (entry) =>
    canonical(slot.values, entry) ??
    slot.labels?.find(([, ls]) =>
      ls.some((l) => fold(l) === fold(entry)),
    )?.[0] ??
    entry;
}

/** The configuration line that names the store a facet is in now. */
export function pinLine(f: ResolvedFacet): string {
  const field = f.store === "field" ? `, field: ${f.field}` : "";
  return `issue_tracker.facets.${f.facet}: { store: ${f.store}${field} }`;
}

/** A facet's store as `facetStores` reports it, without what the tracker answered. */
export function baseReport(slot: FacetSlot): FacetStoreReport {
  if (!usable(slot))
    return {
      facet: slot.facet,
      store: null,
      why: "no facet",
      ...(slot.problem === null ? {} : { problem: slot.problem }),
    };
  const values: Record<string, string> = {};
  for (const [v, labels] of slot.labels ?? []) values[v] = labels[0] as string;
  for (const [v, name] of slot.map?.entries ?? []) values[v] = name;
  return {
    facet: slot.facet,
    store: slot.store,
    why: slot.why,
    ...(slot.field === null ? {} : { field: slot.field }),
    values,
    ...(slot.why === "configured" ? {} : { pin: pinLine(slot) }),
  };
}
