/**
 * The Jira adapter's own facet stores: a type kept in the project's issue
 * types (`native`), a type or a size kept in a custom field named by its
 * name or id (`field`), beside priority in Jira's priority field
 * (`issue_tracker.jira.priorities`), as the adapter always kept it.
 *
 * Only a store a repository names is read or written here (or the field
 * store an `issue_tracker.jira.field_labels` entry whose labels are a
 * facet's values gives it): a repository that names none reads and writes
 * exactly what it did before. A field store's field is read in the request
 * that reads the rest of the issue, and written in the request that files or
 * changes it; every name resolves before anything is written, a field the
 * create or edit screen of the issue's type lacks is refused, naming the
 * issue type, and a value that names no option of the field's screen is
 * refused, naming the options.
 *
 * Every Jira issue has an issue type. With the issue type as the type's
 * store, a type with no issue type of its own name (and no other name in
 * `values`) is filed as `issue_tracker.jira.issue_type` and keeps its value
 * in its label, as does an issue created under another issue: under a
 * standard issue it is a sub-task, and under an Epic it gets `issue_type`. A
 * type label wins over such a fallback issue type (`issue_type` or a
 * sub-task type); any other two different values read as no type.
 */

import { failedHealth, isUnavailable } from "../unavailable.ts";
import { TrackerConfigError } from "../config-error.ts";
import { readSignal, refuseStopped } from "../facets/bounds.ts";
import { type Facets, type ResolvedFacet, usable } from "../facets/config.ts";
import { type LabelCodec, labelCodec } from "../facets/label.ts";
import type { CoreFacetReport } from "../facets/tracker.ts";
import {
  fold,
  numberedValue,
  numberIsShared,
  sharedNumber,
} from "../facets/values.ts";
import {
  type Facet,
  FACETS,
  type FacetReadOptions,
  type IssuePatch,
  type NewIssue,
  TrackerRequestError,
} from "../port.ts";
import type {
  Client,
  FieldMeta,
  IssueTypeMeta,
  PriorityMeta,
} from "./client.ts";
import type { JiraIssue } from "./read.ts";

/** A field of the site, as `GET field` lists it. */
export interface SiteField {
  id: string;
  name: string;
  schema: unknown;
  /** The names JQL knows the field by (`fixVersion` for `fixVersions`); absent when the site lists none. */
  clauseNames?: string[];
}

/** A custom field a facet is kept in, resolved against the site. */
export interface FacetField {
  facet: Facet;
  /** The field as the configuration names it. */
  configured: string;
  id: string;
  name: string;
  /** How a value is kept: one option, a number, text, or a list of options or of text. */
  kind: "option" | "number" | "string" | "options" | "strings";
}

const same = (a: string, b: string) => fold(a) === fold(b);

const at = (f: Facet, key?: string) =>
  `issue_tracker.facets.${f}${key === undefined ? "" : `.${key}`}`;

/** The facets kept in a custom field. */
export function facetFieldStores(facets: Facets): ResolvedFacet[] {
  return FACETS.map((f) => facets[f]).filter(
    (s): s is ResolvedFacet => usable(s) && s.store === "field",
  );
}

/**
 * Refuse a Jira facet configuration that keeps two facets in one field, as
 * named. Pure, so the audit refuses what the adapter refuses offline.
 */
export function checkJiraFacets(facets: Facets): void {
  const owners = new Map<string, Facet>();
  for (const s of facetFieldStores(facets)) {
    const other = owners.get(fold(s.field ?? ""));
    if (other !== undefined)
      throw new TrackerConfigError(
        at(s.facet, "field"),
        `${at(s.facet, "field")} keeps ${s.facet} in the field '${s.field}', which also keeps ${other}; one field cannot hold two facets`,
      );
    owners.set(fold(s.field ?? ""), s.facet);
  }
}

/** How a field of this schema keeps a facet, or a refusal naming why it cannot. */
function kindOf(
  schema: unknown,
  where: string,
  name: string,
): FacetField["kind"] {
  const r = (schema ?? {}) as Record<string, unknown>;
  const custom = typeof r.custom === "string" ? r.custom : "";
  if (typeof r.system === "string")
    throw new TrackerConfigError(
      where,
      `${where}: the field '${name}' is one of Jira's system fields; a facet is kept in a custom field`,
    );
  const rich =
    custom.endsWith(":textarea") ||
    r.system === "description" ||
    r.system === "environment";
  if (!rich && r.type === "string") return "string";
  if (r.type === "number") return "number";
  if (r.type === "option") return "option";
  if (r.type === "array" && r.items === "option") return "options";
  if (!rich && r.type === "array" && r.items === "string") return "strings";
  throw new TrackerConfigError(
    where,
    `${where}: the field '${name}' is of type ${JSON.stringify(r.type)}${r.items === undefined ? "" : ` of ${JSON.stringify(r.items)}`}${rich ? " (rich text)" : ""}; a facet is kept in a single-line text, number, select, multi-select, checkbox or labels field`,
  );
}

/** The site's fields a configured field names: the one with that id, else each with that name, ignoring case. */
export function fieldsNamed(
  all: ReadonlyArray<SiteField>,
  configured: string,
): SiteField[] {
  const byId = all.filter((f) => f.id === configured);
  return byId.length > 0 ? byId : all.filter((f) => same(f.name, configured));
}

/**
 * The field of each field store, by id or else by name, ignoring case: a
 * name several fields share is refused, naming each one's id, and so is one
 * field holding two facets.
 */
export function resolveFacetFields(
  stores: ReadonlyArray<ResolvedFacet>,
  all: ReadonlyArray<SiteField>,
): FacetField[] {
  const out: FacetField[] = [];
  for (const s of stores) {
    const configured = s.field ?? "";
    const where = at(s.facet, "field");
    const matches = fieldsNamed(all, configured);
    if (matches.length !== 1)
      throw new TrackerConfigError(
        where,
        matches.length === 0
          ? `${where}: '${configured}' names no field of the site; name it by its name or its id (customfield_10016)`
          : `${where}: '${configured}' is the name of ${matches.length} fields of the site (${matches.map((f) => f.id).join(", ")}); name the field by its id`,
      );
    const f = matches[0] as SiteField;
    const other = out.find((o) => o.id === f.id);
    if (other !== undefined)
      throw new TrackerConfigError(
        where,
        `${where}: the field '${f.name}' (${f.id}) also keeps ${other.facet}; one field cannot hold two facets`,
      );
    out.push({
      facet: s.facet,
      configured,
      id: f.id,
      name: f.name,
      kind: kindOf(f.schema, where, f.name),
    });
  }
  return out;
}

/** What a write gives Jira for the facets kept here. */
export interface FacetWrite {
  fields: Record<string, unknown>;
  add: string[];
  remove: string[];
  /** The type value set through the issue type, and the issue type it moves to. */
  typeMove?: { value: string; to: string };
}

/** What the Jira adapter reads and writes of the facets it keeps itself. */
export interface JiraFacetStores {
  /** The facets the adapter keeps: priority where native, type and size where kept in Jira's own fields. */
  readonly own: ReadonlySet<Facet>;
  /** The type and size kept here, read off an issue, and those whose value names no canonical one. */
  read(issue: JiraIssue): {
    type?: string | null;
    size?: string | null;
    unmappedFacets?: Facet[];
  };
  /** Refuse a label the type keeps itself among labels a write names. */
  refuseLabels(labels: ReadonlyArray<string>, where: string): void;
  /**
   * The issue type and fields a new issue is filed with: `issueType` is the
   * one it gets without a type store, `top` whether it has no parent.
   */
  create(
    issue: NewIssue,
    placed: { issueType: string; top: boolean },
  ): Promise<FacetWrite & { issueType: string }>;
  /** What a patch of the facets kept here writes to `issue`. */
  update(
    issue: JiraIssue,
    patch: IssuePatch,
    signal?: AbortSignal,
  ): Promise<FacetWrite>;
  /** The fields absent from the screens through which a missing facet could be set. */
  unavailableFacets: NonNullable<
    import("../port.ts").Tracker["unavailableFacets"]
  >;
  /** Each named store's health, for `facetStores()`. */
  report(options?: FacetReadOptions): Promise<CoreFacetReport>;
}

/** A screen a write goes through, and what it is the screen of, for a message; `null` where none was read. */
type Screen = { screen: FieldMeta; what: string } | null;

/** Why a facet cannot be written through a screen that lacks its field. */
const notOn = (
  s: ResolvedFacet,
  field: FacetField,
  where: string,
  it: string,
) =>
  `${s.facet} is kept in the field '${field.name}' (${field.id}), which is not on ${where}; add it to ${it}, or keep ${s.facet} in labels (store: label)`;

/** Refuse a field the screen lacks; unchecked where no screen was read. */
function onScreen(s: ResolvedFacet, field: FacetField, found: Screen): void {
  if (found !== null && !found.screen.has(field.id))
    throw new TrackerRequestError(
      "unresolved",
      notOn(s, field, found.what, "the screen"),
    );
}

/** `A`, `A and B`, `A, B and C`. */
function listed(names: ReadonlyArray<string>, last = "and"): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;
}

const article = (name: string) => (/^[aeiou]/i.test(name) ? "an" : "a");

/** The health of a field store whose field the create screens of `lacking` do not hold. */
function lackingHealth(
  s: ResolvedFacet,
  field: FacetField,
  lacking: ReadonlyArray<string>,
  project: string,
  restricted: ReadonlyArray<string> = [],
) {
  const many = lacking.length > 1;
  return {
    status: "failed" as const,
    unavailable: false,
    error: notOn(
      s,
      field,
      `the create screen${many ? "s" : ""} of ${listed(lacking)} in ${project}`,
      many ? "those screens" : "the screen",
    ).slice(0, 300),
    fails: `filing ${listed(
      [...lacking, ...restricted].map((n) => `${article(n)} ${n}`),
      "or",
    )} fails`,
  };
}

/** The standard issue types: neither sub-tasks nor above the standard level. */
const standard = (types: IssueTypeMeta[]) =>
  types.filter((t) => !t.subtask && t.level === 0);

export function jiraFacetStores(client: Client): JiraFacetStores {
  const { facets, project, settings } = client;
  const type =
    usable(facets.type) && facets.type.store === "native" ? facets.type : null;
  const fields = facetFieldStores(facets);
  const own = new Set<Facet>(
    facets.priority.store === "native" ? ["priority"] : [],
  );
  if (type !== null) own.add("type");
  for (const s of fields) own.add(s.facet);
  /** The labels a native type keeps a value in where its issue type cannot. */
  const fallback: LabelCodec | null =
    type === null
      ? null
      : labelCodec({ ...type, store: "label", labels: type.fallback ?? [] });

  /** Whether an issue type is a fallback, beside which a type label wins. */
  const isFallback = (t: JiraIssue["issueType"]) =>
    t === null || t.subtask || same(t.name, settings.issueType);

  function readType(issue: JiraIssue, slot: ResolvedFacet) {
    const labelled = new Set(
      issue.labels
        .map((l) => fallback?.read([l]) ?? null)
        .filter((v): v is string => v !== null),
    );
    const t = issue.issueType;
    const typed = t === null ? null : (slot.map?.fromTracker(t.name) ?? null);
    const values = new Set(labelled);
    if (typed !== null && !(isFallback(t) && labelled.size > 0))
      values.add(typed);
    const unmapped = t !== null && typed === null && !isFallback(t);
    return {
      value: !unmapped && values.size === 1 ? ([...values][0] as string) : null,
      unmapped,
    };
  }

  /** The canonical value one value of a field names, or `null`. */
  function fromValue(
    s: ResolvedFacet,
    raw: string,
    numeric: boolean,
  ): string | null {
    if (numeric && Number.isFinite(Number(raw)) && raw.trim() !== "") {
      const n = Number(raw);
      if (numberIsShared(s.map, n)) return null;
    }
    const exact = s.map?.fromTracker(raw) ?? null;
    if (
      exact !== null ||
      !numeric ||
      raw.trim() === "" ||
      !Number.isFinite(Number(raw))
    )
      return exact;
    return numberedValue(s.map, Number(raw));
  }

  function readField(issue: JiraIssue, s: ResolvedFacet) {
    const raws = issue.facetValues[s.facet];
    if (raws === undefined)
      throw new TrackerRequestError(
        "invalid",
        `issue ${issue.key} was read without the field '${s.field}' that ${s.facet} is kept in`,
      );
    const numeric = issue.numericFacets?.includes(s.facet) === true;
    const named = raws.map((r) => fromValue(s, r, numeric));
    const values = new Set(named.filter((v): v is string => v !== null));
    const unmapped = named.includes(null);
    return {
      value: !unmapped && values.size === 1 ? ([...values][0] as string) : null,
      unmapped,
    };
  }

  async function fieldOf(s: ResolvedFacet, signal?: AbortSignal) {
    const found = (await client.facetFields(signal)).find(
      (f) => f.facet === s.facet,
    );
    if (found === undefined)
      throw new TrackerRequestError(
        "unresolved",
        `${s.facet}'s field '${s.field}' was not resolved`,
      );
    return found;
  }

  /** The standard issue type of a type value's name, `null` where the project has none. */
  async function keptAs(
    value: string,
    signal?: AbortSignal,
  ): Promise<IssueTypeMeta | null> {
    const name = type?.map?.toTracker(value) ?? value;
    const types = standard(await client.issueTypes(signal));
    return types.find((t) => same(t.name, name)) ?? null;
  }

  /** The issue type a type value is kept as, `null` where it falls back to `issue_type` and its label. */
  async function issueTypeOf(
    value: string,
    signal?: AbortSignal,
  ): Promise<IssueTypeMeta | null> {
    const found = await keptAs(value, signal);
    const named = type?.named?.some((v) => same(v, value)) === true;
    if (found !== null || !named) return found;
    const name = type?.map?.toTracker(value) ?? value;
    const types = standard(await client.issueTypes(signal));
    throw new TrackerRequestError(
      "unresolved",
      `type ${value} is kept in Jira's issue types as '${name}', which is no standard issue type of ${project} (it has: ${types.map((t) => t.name).join(", ") || "none"}); name its issue type in ${at("type", "values")}, or keep type in labels (store: label)`,
    );
  }

  /** `issue_tracker.jira.issue_type`, which a type with no issue type of its own falls back to. */
  async function fallbackType(signal?: AbortSignal): Promise<IssueTypeMeta> {
    const found = (await client.issueTypes(signal)).find((t) =>
      same(t.name, settings.issueType),
    );
    if (found === undefined)
      throw new TrackerRequestError(
        "unresolved",
        `issue_tracker.jira.issue_type names '${settings.issueType}', which is no issue type of ${project}`,
      );
    return found;
  }

  /** The value Jira takes for a facet kept in a field, checked against `meta`'s screen. */
  async function encode(
    s: ResolvedFacet,
    value: string,
    meta: () => Promise<Screen>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const field = await fieldOf(s, signal);
    const found = await meta();
    onScreen(s, field, found);
    const name = s.map?.toTracker(value) ?? value;
    if (field.kind === "number") return numberOf(s, value, name, field);
    if (field.kind === "string") return name;
    if (field.kind === "strings") {
      if (!/^\S{1,255}$/.test(name))
        throw new TrackerRequestError(
          "invalid",
          `${s.facet} ${value} is kept as '${name}' in the labels field '${field.name}', which holds no whitespace`,
        );
      return [name];
    }
    const option = optionOf(s, value, name, field, found);
    return field.kind === "option" ? { value: option } : [{ value: option }];
  }

  /** A number field's value: each value its own number. */
  function numberOf(
    s: ResolvedFacet,
    value: string,
    name: string,
    field: FacetField,
  ): number {
    if (!Number.isFinite(Number(name)) || sharedNumber(s.map) !== undefined)
      throw new TrackerRequestError(
        "invalid",
        `${s.facet} ${value} is kept as '${name}' in the number field '${field.name}'; give each ${s.facet} its own number in ${at(s.facet, "values")}`,
      );
    return Number(name);
  }

  /** An option of the field's screen, as the screen spells it; unchecked where no screen was read. */
  function optionOf(
    s: ResolvedFacet,
    value: string,
    name: string,
    field: FacetField,
    found: Screen,
  ): string {
    if (found === null) return name;
    const allowed = found.screen.get(field.id) ?? null;
    if (allowed === null) return name;
    const match = allowed.find((o) => same(o, name));
    if (match === undefined)
      throw new TrackerRequestError(
        "unresolved",
        `${s.facet} ${value} is kept as the option '${name}' of the field '${field.name}', which has ${allowed.join(", ") || "no options"}; name the option in ${at(s.facet, "values")}, or keep ${s.facet} in labels (store: label)`,
      );
    return match;
  }

  /** The create screen of an issue type, by its name; `null` where the project lists no such type. */
  function createScreen(issueType: string, signal?: AbortSignal) {
    return async () => {
      const t = (await client.issueTypes(signal)).find((x) =>
        same(x.name, issueType),
      );
      if (t === undefined) return null;
      return {
        screen: await client.createMeta(t.id, signal),
        what: `the create screen of ${t.name} in ${project}`,
      };
    };
  }

  /** The fields a write of `values` sets, each checked against its screen. */
  async function fieldWrites(
    values: { type?: string | null; size?: string | null },
    meta: () => Promise<Screen>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    let screen: Promise<Screen> | undefined;
    const once = () => {
      screen ??= meta();
      return screen;
    };
    for (const s of fields) {
      const v = s.facet === "priority" ? undefined : values[s.facet];
      if (v === undefined) continue;
      const field = await fieldOf(s, signal);
      if (v === null) onScreen(s, field, await once());
      out[field.id] =
        v === null
          ? field.kind === "options" || field.kind === "strings"
            ? []
            : null
          : await encode(s, v, once, signal);
    }
    return out;
  }

  /**
   * Refuses, before anything is written, an issue type the issue's edit
   * screen lists the choices of and does not offer: Jira changes an issue
   * type by an edit only between issue types of one workflow and field
   * configuration, and answers any other change with a bare 400 on
   * `issuetype`. A screen without an `issuetype` entry, or with no field at all,
   * proves nothing, since editmeta is also filtered by screen configuration
   * and the caller's permissions: that write goes ahead, and Jira's rejection
   * is explained afterward.
   */
  async function refuseUneditableType(
    issue: JiraIssue,
    target: IssueTypeMeta,
    kept: string,
    editScreen: () => Promise<FieldMeta>,
  ) {
    const screen = await editScreen();
    const offered = screen.get("issuetype");
    if (
      offered === undefined ||
      offered === null ||
      offered.some((n) => same(n, target.name))
    )
      return;
    const from = issue.issueType?.name ?? "its issue type";
    const others = offered.filter((n) => !same(n, issue.issueType?.name ?? ""));
    throw new TrackerRequestError(
      "unresolved",
      `${kept}, but the edit screen of ${issue.key} lets its issue type change from ${from} to ${others.length === 0 ? "no other type" : `${others.join(", ")} only`}: Jira changes an issue type by an edit only between issue types of one workflow and field configuration; move ${issue.key} to ${target.name} in Jira, or keep type in labels or a field (store: label or store: field)`,
    );
  }

  /** What setting the type (or none) on an issue writes, through its issue type or its label. */
  async function typeChange(
    issue: JiraIssue,
    value: string | null,
    editScreen: () => Promise<FieldMeta>,
    signal?: AbortSignal,
  ): Promise<FacetWrite> {
    const slot = type as ResolvedFacet;
    const codec = fallback as LabelCodec;
    const carried = issue.labels.filter((l) => codec.owns(l));
    const t = issue.issueType;
    if (value === null) {
      const typed = t === null ? null : (slot.map?.fromTracker(t.name) ?? null);
      if (typed !== null)
        throw new TrackerRequestError(
          "invalid",
          `a Jira issue always has an issue type, and ${issue.key}'s is ${t?.name}, the type ${typed}; give it another type instead`,
        );
      return { fields: {}, add: [], remove: carried };
    }
    if (t?.subtask === true)
      return { fields: {}, ...codec.change(carried, value) };
    const typed = await issueTypeOf(value, signal);
    if (typed !== null) {
      if (t !== null && same(t.name, typed.name))
        return { fields: {}, add: [], remove: carried };
      await refuseUneditableType(
        issue,
        typed,
        `type ${value} is kept in Jira's issue types as '${typed.name}'`,
        editScreen,
      );
      return {
        fields: { issuetype: { id: typed.id } },
        add: [],
        remove: carried,
        typeMove: { value, to: typed.name },
      };
    }
    const change = codec.change(carried, value);
    if (isFallback(t)) return { fields: {}, ...change };
    const base = await fallbackType(signal);
    await refuseUneditableType(
      issue,
      base,
      `type ${value} is kept in the label '${codec.labelOf(value)}' on the issue type ${base.name}`,
      editScreen,
    );
    return {
      fields: { issuetype: { id: base.id } },
      ...change,
      typeMove: { value, to: base.name },
    };
  }

  /** The create screen of each issue type among `names` the project has. */
  async function createScreens(names: string[], signal?: AbortSignal) {
    const all = await client.issueTypes(signal);
    const types: IssueTypeMeta[] = [];
    for (const n of names) {
      const t = all.find((x) => same(x.name, n));
      if (t !== undefined && !types.includes(t)) types.push(t);
    }
    const screens: { t: IssueTypeMeta; screen: FieldMeta }[] = [];
    for (const t of types) {
      refuseStopped(signal);
      screens.push({ t, screen: await client.createMeta(t.id, signal) });
    }
    return screens;
  }

  /** The first refusal a create screen gives a value of the store, or null when it offers them all. */
  async function screenRefusal(
    s: ResolvedFacet,
    { t, screen }: { t: IssueTypeMeta; screen: FieldMeta },
    signal?: AbortSignal,
  ) {
    let first: string | null = null;
    for (const v of s.values) {
      refuseStopped(signal);
      const what = `the create screen of ${t.name} in ${project}`;
      try {
        await encode(s, v, async () => ({ screen, what }), signal);
      } catch (err) {
        if (!(err instanceof TrackerRequestError) || isUnavailable(err))
          throw err;
        first ??= err.message;
      }
    }
    return first;
  }

  /** The issue types whose create screen offers fewer options than the store's values, with the first refusal of each. */
  async function restrictedTypes(
    s: ResolvedFacet,
    screens: { t: IssueTypeMeta; screen: FieldMeta }[],
    signal?: AbortSignal,
  ) {
    const restricted = new Map<string, string>();
    for (const x of screens) {
      const refusal = await screenRefusal(s, x, signal);
      if (refusal !== null && !restricted.has(x.t.name))
        restricted.set(x.t.name, refusal);
    }
    return restricted;
  }

  /** The health where a create screen offers fewer options than the store's values; it stops only the filing of its type. */
  function restrictedHealth(restricted: Map<string, string>) {
    if (restricted.size === 0) return null;
    return {
      status: "failed" as const,
      unavailable: false,
      error: [...restricted.values()][0]?.slice(0, 300) ?? "",
      fails: `filing ${listed(
        [...restricted.keys()].map((n) => `${article(n)} ${n}`),
        "or",
      )} fails`,
    };
  }

  /**
   * A field store's health: its field on the create screen of each issue
   * type Jig files, and each value an option there. An epic type is asked no
   * size, so its screen is not checked for one; a type value with no issue
   * type is the type facet's own finding, and a pool name the project lacks
   * is refused where the pool is read.
   */
  async function fieldHealth(s: ResolvedFacet, signal?: AbortSignal) {
    const field = await fieldOf(s, signal);
    // The issue types a filing uses, and the pool's, which a person files by hand.
    const names = [
      ...(await filedTypes(signal, keptAs)),
      ...settings.poolIssueTypes,
    ].filter(
      (n) => s.facet !== "size" || !facets.epicTypes.some((e) => same(e, n)),
    );
    const screens = await createScreens(names, signal);
    // A mapping no screen can satisfy blocks every write, so it is judged first
    // and fails the whole store whatever the screens lack.
    for (const v of s.values) {
      refuseStopped(signal);
      await encode(s, v, async () => null, signal);
    }
    const lacking = screens.filter((x) => !x.screen.has(field.id));
    // A screen without the field fails its type's filing; the screens that
    // have it are still checked, so the health names every type that fails.
    const restricted = await restrictedTypes(
      s,
      screens.filter((x) => x.screen.has(field.id)),
      signal,
    );
    if (lacking.length > 0)
      return lackingHealth(
        s,
        field,
        lacking.map((x) => x.t.name),
        project,
        [...restricted.keys()],
      );
    return restrictedHealth(restricted) ?? { status: "ok" as const };
  }

  async function health(s: ResolvedFacet, signal?: AbortSignal) {
    try {
      if (s.store !== "native") return await fieldHealth(s, signal);
      await fallbackType(signal);
      for (const v of s.values) {
        refuseStopped(signal);
        await issueTypeOf(v, signal);
      }
      return { status: "ok" as const };
    } catch (err) {
      return failedHealth(err);
    }
  }

  /** Each priority name is one of the site's priorities, exactly once. */
  function checkPriorityNames(names: string[], site: PriorityMeta[]) {
    for (const name of names) {
      const matches = site.filter((p) => same(p.name, name)).length;
      if (matches !== 1)
        throw new TrackerRequestError(
          "unresolved",
          `priority '${name}' (issue_tracker.jira.priorities) matches ${matches} of the site's priorities (${site.map((p) => p.name).join(", ") || "none"}), expected exactly 1`,
        );
    }
  }

  /** A create screen has the priority field, and every name among its values. */
  function checkPriorityScreen(
    names: string[],
    found: { screen: FieldMeta; what: string },
  ) {
    if (!found.screen.has("priority"))
      throw new TrackerRequestError(
        "unresolved",
        `the priority field is not on ${found.what}, so a priority cannot be set when an issue is filed; add it to the screen, or keep priority in labels (store: label)`,
      );
    const allowed = found.screen.get("priority") ?? null;
    const missing = names.find((n) => !allowed?.some((a) => same(a, n)));
    if (allowed !== null && missing !== undefined)
      throw new TrackerRequestError(
        "unresolved",
        `priority '${missing}' is not among the values of the priority field on ${found.what} (${allowed.join(", ") || "none"}); name another in issue_tracker.jira.priorities`,
      );
  }

  /**
   * The issue types a filing uses: the configured ones, and those a native
   * type is kept as, each found by `keep` (by default refusing a value whose
   * named issue type the project lacks).
   */
  async function filedTypes(
    signal?: AbortSignal,
    keep: typeof issueTypeOf = issueTypeOf,
  ): Promise<string[]> {
    const names = [settings.issueType];
    if (settings.subtaskType !== null) names.push(settings.subtaskType);
    else {
      // Filing a child of a standard parent uses the project's one sub-task type.
      const subtasks = (await client.issueTypes(signal)).filter(
        (t) => t.subtask,
      );
      const [only] = subtasks;
      if (subtasks.length === 1 && only !== undefined) names.push(only.name);
    }
    for (const value of type?.values ?? []) {
      const kept = await keep(value, signal);
      if (kept !== null) names.push(kept.name);
    }
    return names.filter((n, i) => names.findIndex((m) => same(m, n)) === i);
  }

  /**
   * A native priority store's health: each priority's name is one of the
   * site's priorities, and the create screen of each issue type filed (see
   * `filedTypes`) has the priority field with each name among its values.
   */
  async function priorityHealth(signal?: AbortSignal) {
    try {
      const names = [1, 2, 3, 4].flatMap((n) => {
        const name = client.model.priorityName(n);
        return name === null ? [] : [name];
      });
      // Every configured name must be a site priority; the create screens
      // need only the names a write uses.
      checkPriorityNames(
        Object.values(settings.priorities).flat(),
        await client.priorities(signal),
      );
      for (const issueType of await filedTypes(signal)) {
        refuseStopped(signal);
        const found = await createScreen(issueType, signal)();
        if (found === null)
          throw new TrackerRequestError(
            "unresolved",
            `'${issueType}' is no issue type of ${project}, so a priority cannot be set when one is filed`,
          );
        checkPriorityScreen(names, found);
      }
      return { status: "ok" as const };
    } catch (err) {
      return failedHealth(err);
    }
  }

  /**
   * A priority the site names but the configuration maps to none of Jig's
   * reads as 0 (none), the same as an empty one; only the first was ranked
   * by someone.
   */
  function priorityUnmapped(issue: Parameters<typeof readType>[0]): boolean {
    return (
      facets.priority.store === "native" &&
      issue.priority !== null &&
      client.model.priorityOf(issue.priority) === 0
    );
  }

  return {
    own,
    read(issue) {
      const out: ReturnType<JiraFacetStores["read"]> = {};
      const unmapped: Facet[] = [];
      if (priorityUnmapped(issue)) unmapped.push("priority");
      if (type !== null) {
        const r = readType(issue, type);
        out.type = r.value;
        if (r.unmapped) unmapped.push("type");
      }
      for (const s of fields) {
        if (s.facet === "priority") continue;
        const r = readField(issue, s);
        out[s.facet] = r.value;
        if (r.unmapped) unmapped.push(s.facet);
      }
      if (unmapped.length > 0) out.unmappedFacets = unmapped;
      return out;
    },

    refuseLabels(labels, where) {
      if (fallback === null) return;
      const owned = labels.find((l) => fallback.owns(l));
      if (owned === undefined) return;
      const value = fallback.read([owned]) as string;
      throw new TrackerRequestError(
        "invalid",
        `the label '${owned}' ${where} is the type ${value}; give it as the issue's type (type: ${value}), not as a label`,
      );
    },

    async create(issue, placed) {
      let issueType = placed.issueType;
      const add: string[] = [];
      if (type !== null && issue.type !== undefined) {
        const typed = placed.top ? await issueTypeOf(issue.type) : null;
        if (typed !== null) issueType = typed.name;
        else add.push((fallback as LabelCodec).labelOf(issue.type));
      }
      const written = await fieldWrites(issue, createScreen(issueType));
      return { issueType, fields: written, add, remove: [] };
    },

    async unavailableFacets(nativeType, candidates, key, signal) {
      const relevant = fields.filter((field) =>
        candidates.includes(field.facet),
      );
      if (nativeType === null || relevant.length === 0) return [];
      const create = await createScreen(nativeType, signal)();
      if (create === null) return [];
      let edit: Promise<FieldMeta> | undefined;
      const unavailable: Facet[] = [];
      for (const slot of relevant) {
        const field = await fieldOf(slot, signal);
        if (create.screen.has(field.id)) continue;
        if (key !== undefined) {
          edit ??= client.editMeta(key, signal);
          if ((await edit).has(field.id)) continue;
        }
        unavailable.push(slot.facet);
      }
      return unavailable;
    },

    async update(issue, patch, signal) {
      const out: FacetWrite = { fields: {}, add: [], remove: [] };
      let edit: Promise<FieldMeta> | undefined;
      const editScreen = () => {
        edit ??= client.editMeta(issue.key, signal);
        return edit;
      };
      if (type !== null && patch.type !== undefined) {
        const change = await typeChange(issue, patch.type, editScreen, signal);
        const kept = [...issue.labels, ...change.add].filter(
          (l) => !change.remove.some((r) => same(r, l)),
        );
        const dropped = (patch.removeLabels ?? []).find((l) =>
          kept.some((k) => same(k, l) && fallback?.owns(k) === true),
        );
        if (dropped !== undefined)
          throw new TrackerRequestError(
            "invalid",
            `the label '${dropped}' to remove is the type '${patch.type}' this write sets`,
          );
        Object.assign(out.fields, change.fields);
        out.add.push(...change.add);
        out.remove.push(...change.remove);
        if (change.typeMove !== undefined) out.typeMove = change.typeMove;
      }
      Object.assign(
        out.fields,
        await fieldWrites(
          patch,
          async () => ({
            screen: await editScreen(),
            what: `the edit screen of ${issue.key}${issue.issueType === null ? "" : ` (${issue.issueType.name})`}`,
          }),
          signal,
        ),
      );
      return out;
    },

    async report(options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const out: CoreFacetReport["facets"] = {};
      for (const s of [...(type === null ? [] : [type]), ...fields])
        out[s.facet] = { health: await health(s, signal) };
      if (facets.priority.store === "native")
        out.priority = { health: await priorityHealth(signal) };
      return {
        facets: out,
        discovery: {
          status: "none",
          reason: "the jira adapter discovers no organization's fields",
        },
      };
    },
  };
}
