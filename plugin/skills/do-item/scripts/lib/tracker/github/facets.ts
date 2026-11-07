/**
 * The GitHub adapter's own facet stores: an issue's type kept in GitHub's
 * issue types (`native`), and any facet kept in an issue field of the
 * repository's organization (`field`; a `native` priority is its Priority
 * field), beside priority kept in labels as the adapter always kept it.
 *
 * Only a store a repository names is read or written here: a repository that
 * names none reads and writes exactly what it did before. A read adds the
 * issue type's name and the issue's field values to the fields every issue
 * read requests, so no list read makes a request per issue; field values come
 * 25 to a page, and an issue with more is read again alone. Every name is
 * resolved before anything is written: a value that names no issue type or no
 * option is refused, naming what the repository has.
 *
 * Detection reads what the GitHub default would select for a facet the
 * configuration does not name, and the organization's discovery what it
 * offers; both only report (`facetStores()`). A failed read is an error
 * naming the read and the credential, carried as the transport reports it,
 * never "the organization has no field".
 */

import { TrackerConfigError } from "../config-error.ts";
import type { CoreFacetReport } from "../facets/tracker.ts";
import { type Facets, type ResolvedFacet, usable } from "../facets/config.ts";
import { detection, type Evidence } from "../facets/detect.ts";
import {
  fold,
  PRIORITY_NAMES,
  priorityName,
  priorityNumber,
  type PriorityName,
} from "../facets/values.ts";
import {
  type Facet,
  type FacetDetection,
  type IssuePatch,
  type NewIssue,
  TrackerRequestError,
} from "../port.ts";
import type { GitHubModel } from "./model.ts";
import { type GhIssue, onePage, record, str } from "./read.ts";
import { type Repo, slug } from "./refs.ts";
import { GitHubApiError, type GitHubTransport, pageAll } from "./transport.ts";

/** Field values per page of an issue's field list. */
const FIELD_PAGE = 25;

const FIELD_VALUE_NODES = `nodes {
  __typename
  ... on IssueFieldSingleSelectValue { id name field { ... on IssueFieldSingleSelect { name } } }
  ... on IssueFieldNumberValue { id value field { ... on IssueFieldNumber { name } } }
  ... on IssueFieldTextValue { id value field { ... on IssueFieldText { name } } }
  ... on IssueFieldDateValue { id }
  ... on IssueFieldMultiSelectValue { id }
}`;

const FIELD_VALUES = (after: string) =>
  `issueFieldValues(first: ${FIELD_PAGE}${after}) { pageInfo { hasNextPage endCursor } ${FIELD_VALUE_NODES} }`;

const ISSUE_FIELD_VALUES = `
query TrackerIssueFieldValues($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { ${FIELD_VALUES(", after: $after")} }
  }
}`;

const FIELD_DEFS = `nodes {
  __typename
  ... on IssueFieldSingleSelect { id name dataType options { id name } }
  ... on IssueFieldNumber { id name dataType }
  ... on IssueFieldText { id name dataType }
  ... on IssueFieldDate { id name dataType }
  ... on IssueFieldMultiSelect { id name dataType }
}`;

const STORE_QUERY = `
query TrackerFacetStores($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 100) { pageInfo { hasNextPage } nodes { id name } }
    issueFields(first: 100) { pageInfo { hasNextPage } ${FIELD_DEFS} }
  }
}`;

const OWNER_QUERY = `
query TrackerFacetOwner($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { owner { __typename login } }
}`;

const DISCOVERY_QUERY = `
query TrackerFacetDiscovery($login: String!) {
  organization(login: $login) {
    issueTypes(first: 100) { pageInfo { hasNextPage } nodes { name } }
    issueFields(first: 100) { pageInfo { hasNextPage } ${FIELD_DEFS} }
  }
}`;

/** An issue field as the repository's organization defines it. */
interface FieldDef {
  id: string;
  name: string;
  dataType: string;
  options: Array<{ id: string; name: string }>;
}

/** The repository's issue types and issue fields, with their ids. */
interface StoreIds {
  types: Array<{ id: string; name: string }>;
  fields: FieldDef[];
}

export interface GitHubFacetOptions {
  facets: Facets;
  home: Repo;
  model: GitHubModel;
  transport: GitHubTransport;
  /** Names the credential the transport uses, never its secret. */
  credential: string;
}

/** What the adapter reads and writes of the facets it keeps itself. */
export interface GitHubFacets {
  /** GraphQL fields every issue read adds; empty when no store needs one. */
  readonly fields: string;
  /** The facets the adapter keeps: priority always, type and size where named in GitHub's own fields. */
  readonly own: ReadonlySet<Facet>;
  /** The facets the adapter keeps, from a node read with `fields`. */
  read(
    issue: GhIssue,
    raw: Record<string, unknown>,
    labels: ReadonlyArray<string>,
  ): Promise<{ priority: number; type?: string | null; size?: string | null }>;
  /** What `createIssue`'s input adds for the facets kept in GitHub's own fields. */
  createInput(issue: NewIssue): Promise<Record<string, unknown>>;
  /** What `updateIssue`'s input adds for a patch of those facets. */
  updateInput(patch: IssuePatch): Promise<Record<string, unknown>>;
  /** Whether a patch changes a facet kept in GitHub's own fields. */
  touches(patch: IssuePatch): boolean;
  /** Store health, detection and discovery, for `facetStores()`. */
  report(): Promise<CoreFacetReport>;
  /**
   * What the GitHub default would select for each facet in `unnamed`.
   * Throws on a failed read: denied, rate limited or timed out, it is never
   * read as "no field".
   */
  detect(unnamed: Facet[]): Promise<Partial<Record<Facet, FacetDetection>>>;
}

const same = (a: string, b: string) => fold(a) === fold(b);

/** GitHub's error types in a message, never the body around them. */
function errorTypes(message: string): string[] {
  return [
    ...new Set(
      [...message.matchAll(/"type"\s*:\s*"([A-Z_]+)"/g)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
}

/** The first line of a message up to any embedded body, at most 120 characters. */
function oneLine(message: string): string {
  const first = message.split(/\r?\n/)[0] ?? "";
  return (first.split(/[{[]/)[0] ?? "").trim().slice(0, 120);
}

/**
 * A failed read or write as one line of at most 300 characters: what was
 * read, the credential and GitHub's status, never a body or a header.
 */
export function facetFailure(
  what: string,
  credential: string,
  err: unknown,
): GitHubApiError {
  if (!(err instanceof GitHubApiError))
    return new GitHubApiError(
      `${what} with ${credential} failed: ${oneLine(err instanceof Error ? err.message : String(err))}`.slice(
        0,
        300,
      ),
    );
  const types = errorTypes(err.message);
  const http = /HTTP (\d{3})/.exec(err.message)?.[1];
  const status = err.notFound
    ? "not found, or not visible to the credential"
    : err.unavailable
      ? `unavailable${err.retryAfterSec === null ? "" : `, retry after ${err.retryAfterSec}s`}`
      : /FORBIDDEN|HTTP 403|not accessible|permission/i.test(err.message)
        ? "refused"
        : "failed";
  const detail = [http === undefined ? "" : `HTTP ${http}`, ...types]
    .filter((s) => s !== "")
    .join(", ");
  const line = `${what} with ${credential}: ${status}${detail === "" ? "" : ` (${detail})`}`;
  return new GitHubApiError(line.slice(0, 300), {
    notFound: err.notFound,
    unavailable: err.unavailable,
    retryAfterSec: err.retryAfterSec,
  });
}

/** An organization's issue fields, read whole: more than one page throws. */
function fieldDefs(v: unknown, where: string): FieldDef[] {
  return onePage(v, where)
    .map((n, i) => record(n, `${where}[${i}]`))
    .filter((n) => typeof n.id === "string")
    .map((n, i) => ({
      id: str(n.id, `${where}[${i}].id`),
      name: str(n.name, `${where}[${i}].name`),
      dataType: str(n.dataType, `${where}[${i}].dataType`),
      options: Array.isArray(n.options)
        ? n.options.map((o, j) => {
            const opt = record(o, `${where}[${i}].options[${j}]`);
            return {
              id: str(opt.id, `${where}[${i}].options[${j}].id`),
              name: str(opt.name, `${where}[${i}].options[${j}].name`),
            };
          })
        : [],
    }));
}

function typeNodes(
  v: unknown,
  where: string,
): Array<{ id: string; name: string }> {
  return onePage(v, where).map((n, i) => {
    const t = record(n, `${where}[${i}]`);
    return {
      id: typeof t.id === "string" ? t.id : "",
      name: str(t.name, `${where}[${i}].name`),
    };
  });
}

/** A field value's field name and its value as text. */
function fieldValueOf(
  n: Record<string, unknown>,
): { field: string; value: string } | null {
  const field = n.field;
  if (field === null || typeof field !== "object" || !("name" in field))
    return null;
  const name = (field as { name: unknown }).name;
  if (typeof name !== "string") return null;
  if (
    n.__typename === "IssueFieldSingleSelectValue" &&
    typeof n.name === "string"
  )
    return { field: name, value: n.name };
  if (
    (n.__typename === "IssueFieldNumberValue" && typeof n.value === "number") ||
    (n.__typename === "IssueFieldTextValue" && typeof n.value === "string")
  )
    return { field: name, value: String(n.value) };
  return null;
}

export function gitHubFacets(opts: GitHubFacetOptions): GitHubFacets {
  const { facets, home, model, transport, credential } = opts;
  const repo = { owner: home.owner, name: home.name };
  const kept = (f: Facet): ResolvedFacet | null => {
    const slot = facets[f];
    return usable(slot) && slot.store !== "label" ? slot : null;
  };
  const typeKept = kept("type");
  const fieldStores = (["type", "priority", "size"] as const)
    .map(kept)
    .filter((s): s is ResolvedFacet => s !== null && s.store === "field");
  const nativePriority = kept("priority");
  const fieldKept = [
    ...fieldStores,
    ...(nativePriority === null ? [] : [nativePriority]),
  ];
  const owners = new Map<string, Facet>();
  for (const s of fieldKept) {
    const name = fold(s.field ?? "Priority");
    const other = owners.get(name);
    if (other !== undefined && other !== s.facet)
      throw new TrackerConfigError(
        `issue_tracker.facets.${s.facet}`,
        `issue_tracker.facets.${s.facet} keeps ${s.facet} in the issue field '${s.field ?? "Priority"}', which also keeps ${other}; one field cannot hold two facets`,
      );
    owners.set(name, s.facet);
  }
  const own = new Set<Facet>(["priority"]);
  if (typeKept !== null) own.add("type");
  if (kept("size") !== null) own.add("size");

  const fields = [
    typeKept?.store === "native" ? "issueType { name }" : "",
    fieldStores.length > 0 || nativePriority !== null ? FIELD_VALUES("") : "",
  ]
    .filter((s) => s !== "")
    .join("\n");

  let ids: Promise<StoreIds> | undefined;
  function storeIds(): Promise<StoreIds> {
    ids ??= (async () => {
      let data: unknown;
      try {
        data = await transport(STORE_QUERY, repo);
      } catch (err) {
        ids = undefined;
        throw facetFailure(
          `reading the issue types and fields of ${slug(home)}`,
          credential,
          err,
        );
      }
      const r = record(record(data, "data").repository, "repository");
      return {
        types: typeNodes(r.issueTypes, "repository.issueTypes"),
        fields: fieldDefs(r.issueFields, "repository.issueFields"),
      };
    })();
    return ids;
  }

  /** The field a field store (or a native priority) is kept in. */
  const fieldName = (s: ResolvedFacet) => s.field ?? "Priority";

  async function fieldOf(s: ResolvedFacet): Promise<FieldDef> {
    const all = (await storeIds()).fields;
    const found = all.find((f) => same(f.name, fieldName(s)));
    if (found === undefined)
      throw new TrackerRequestError(
        "unresolved",
        `${s.facet} is kept in the issue field '${fieldName(s)}', which ${slug(home)} does not have (its fields: ${all.map((f) => f.name).join(", ") || "none"}); name another in issue_tracker.facets.${s.facet}, or keep ${s.facet} in labels (store: label)`,
      );
    if (!["SINGLE_SELECT", "NUMBER", "TEXT"].includes(found.dataType))
      throw new TrackerRequestError(
        "invalid",
        `${s.facet} is kept in the issue field '${found.name}', a ${found.dataType} field; a facet is kept in a single-select, number or text field`,
      );
    return found;
  }

  /** The tracker value a canonical value is written as, checked against the field. */
  async function fieldValue(
    s: ResolvedFacet,
    value: string,
  ): Promise<{
    field: FieldDef;
    name: string;
    input: Record<string, unknown>;
  }> {
    const field = await fieldOf(s);
    const name = s.map?.toTracker(value) ?? value;
    if (field.dataType === "SINGLE_SELECT") {
      const option = field.options.find((o) => same(o.name, name));
      if (option === undefined)
        throw new TrackerRequestError(
          "unresolved",
          `${s.facet} ${value} is kept as the option '${name}' of the issue field '${field.name}', which has ${field.options.map((o) => o.name).join(", ") || "no options"}; name the option in issue_tracker.facets.${s.facet}.values, or keep ${s.facet} in labels (store: label)`,
        );
      return {
        field,
        name: option.name,
        input: { fieldId: field.id, singleSelectOptionId: option.id },
      };
    }
    if (field.dataType === "NUMBER") {
      const n = Number(name);
      const numbers = (s.map?.entries ?? []).map(([, t]) => Number(t));
      if (new Set(numbers).size !== numbers.length)
        throw new TrackerRequestError(
          "invalid",
          `issue_tracker.facets.${s.facet}.values gives two ${s.facet} values the same number in the field '${field.name}'`,
        );
      if (!Number.isFinite(n))
        throw new TrackerRequestError(
          "invalid",
          `${s.facet} ${value} is kept as '${name}' in the number field '${field.name}'; name a number in issue_tracker.facets.${s.facet}.values`,
        );
      return { field, name, input: { fieldId: field.id, numberValue: n } };
    }
    return { field, name, input: { fieldId: field.id, textValue: name } };
  }

  async function issueTypeId(value: string): Promise<string> {
    const name = typeKept?.map?.toTracker(value) ?? value;
    const types = (await storeIds()).types;
    const found = types.find((t) => same(t.name, name));
    if (found === undefined || found.id === "")
      throw new TrackerRequestError(
        "unresolved",
        `type ${value} is kept in GitHub's issue types as '${name}', which ${slug(home)} does not have (it has: ${types.map((t) => t.name).join(", ") || "none"}); name its issue type in issue_tracker.facets.type.values, or keep type in labels (store: label)`,
      );
    return found.id;
  }

  /** Every field value of an issue: from the node, or read alone when it has more pages. */
  async function fieldValues(issue: GhIssue, raw: Record<string, unknown>) {
    const conn = record(
      raw.issueFieldValues,
      `issue ${issue.key}.issueFieldValues`,
    );
    const info = conn.pageInfo;
    if (!Array.isArray(conn.nodes) || info === null || typeof info !== "object")
      throw new GitHubApiError(
        `issue ${issue.key}.issueFieldValues: unreadable`,
      );
    const more = (info as { hasNextPage?: unknown }).hasNextPage;
    if (more === false) return conn.nodes;
    if (more !== true)
      throw new GitHubApiError(
        `issue ${issue.key}.issueFieldValues.pageInfo: unreadable`,
      );
    try {
      return await pageAll(
        transport,
        ISSUE_FIELD_VALUES,
        {
          owner: issue.ref.owner,
          name: issue.ref.name,
          number: issue.ref.number,
        },
        (d) =>
          record(record(d.repository, "repository").issue, `issue ${issue.key}`)
            .issueFieldValues,
        `field values of ${issue.key}`,
      );
    } catch (err) {
      throw facetFailure(
        `reading the field values of ${issue.key}`,
        credential,
        err,
      );
    }
  }

  function fromField(
    s: ResolvedFacet,
    values: Array<{ field: string; value: string }>,
  ): string | null {
    const found = values.find((v) => same(v.field, fieldName(s)));
    if (found === undefined) return null;
    const exact = s.map?.fromTracker(found.value) ?? null;
    if (exact !== null || s.map === null || found.value.trim() === "")
      return exact;
    // A number field returns the number, not its configured spelling.
    const n = Number(found.value);
    return (
      s.map.entries.find(([, t]) => t.trim() !== "" && Number(t) === n)?.[0] ??
      null
    );
  }

  async function read(
    issue: GhIssue,
    raw: Record<string, unknown>,
    labels: ReadonlyArray<string>,
  ) {
    const values =
      fieldStores.length > 0 || nativePriority !== null
        ? (await fieldValues(issue, raw))
            .map((n, i) =>
              fieldValueOf(
                record(n, `issue ${issue.key}.issueFieldValues[${i}]`),
              ),
            )
            .filter((v): v is { field: string; value: string } => v !== null)
        : [];
    const out: {
      priority: number;
      type?: string | null;
      size?: string | null;
    } = {
      priority:
        nativePriority === null
          ? model.priorityOf([...labels])
          : (() => {
              const name = fromField(nativePriority, values);
              return name === null ? 0 : priorityNumber(name as PriorityName);
            })(),
    };
    if (typeKept?.store === "native") {
      const t = raw.issueType;
      const name =
        t === null || t === undefined
          ? null
          : str(
              record(t, `issue ${issue.key}.issueType`).name,
              `issue ${issue.key}.issueType.name`,
            );
      out.type =
        name === null ? null : (typeKept.map?.fromTracker(name) ?? null);
    } else if (typeKept !== null) out.type = fromField(typeKept, values);
    const size = kept("size");
    if (size !== null) out.size = fromField(size, values);
    return out;
  }

  /** The canonical value a write sets a facet to; a priority by its name, 0 as none. */
  function patchValue(
    s: ResolvedFacet,
    patch: IssuePatch | NewIssue,
  ): string | null | undefined {
    const v =
      s.facet === "priority" ? patch.priority : (patch as IssuePatch)[s.facet];
    if (v === undefined || v === null) return v;
    return typeof v === "number" ? priorityName(v) : v;
  }

  async function createInput(
    issue: NewIssue,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    if (typeKept?.store === "native" && issue.type !== undefined)
      input.issueTypeId = await issueTypeId(issue.type);
    const values: Array<Record<string, unknown>> = [];
    for (const s of [
      ...fieldStores,
      ...(nativePriority?.store === "native" ? [nativePriority] : []),
    ]) {
      const v = patchValue(s, issue);
      if (v !== undefined && v !== null)
        values.push((await fieldValue(s, v)).input);
    }
    if (values.length > 0) input.issueFields = values;
    return input;
  }

  async function updateInput(
    patch: IssuePatch,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    if (typeKept?.store === "native" && patch.type !== undefined)
      input.issueTypeId =
        patch.type === null ? null : await issueTypeId(patch.type);
    const updates: Array<Record<string, unknown>> = [];
    for (const s of [
      ...fieldStores,
      ...(nativePriority?.store === "native" ? [nativePriority] : []),
    ]) {
      const v = patchValue(s, patch);
      if (v === undefined) continue;
      if (v === null) {
        const field = await fieldOf(s);
        updates.push({ fieldName: field.name, operation: "CLEAR" });
      } else {
        const { field, name } = await fieldValue(s, v);
        updates.push({ fieldName: field.name, operation: "SET", value: name });
      }
    }
    if (updates.length > 0) input.issueFieldUpdates = updates;
    return input;
  }

  function touches(patch: IssuePatch): boolean {
    return (
      (typeKept !== null && patch.type !== undefined) ||
      (kept("size") !== null && patch.size !== undefined) ||
      (nativePriority !== null && patch.priority !== undefined)
    );
  }

  /** A configured native or field store's health: every value it names resolves. */
  async function health(
    s: ResolvedFacet,
  ): Promise<{ status: "ok" } | { status: "failed"; error: string }> {
    try {
      for (const v of s.values)
        if (s.facet === "type" && s.store === "native") await issueTypeId(v);
        else await fieldValue(s, v);
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  async function discover(): Promise<CoreFacetReport["discovery"]> {
    try {
      const data = record(await transport(OWNER_QUERY, repo), "data");
      const owner = record(
        record(data.repository, "repository").owner,
        "repository.owner",
      );
      if (owner.__typename !== "Organization")
        return {
          status: "none",
          reason: `${slug(home)} belongs to a person, and a person's repositories have no issue types or fields`,
        };
      const org = record(
        record(
          await transport(DISCOVERY_QUERY, {
            login: str(owner.login, "owner.login"),
          }),
          "data",
        ).organization,
        "organization",
      );
      return {
        status: "read",
        credential,
        issueTypes: typeNodes(org.issueTypes, "organization.issueTypes").map(
          (t) => t.name,
        ),
        fields: fieldDefs(org.issueFields, "organization.issueFields").map(
          (f) => ({
            name: f.name,
            dataType: f.dataType,
            options: f.options.map((o) => o.name),
          }),
        ),
      };
    } catch (err) {
      return {
        status: "unavailable",
        credential,
        error: facetFailure(
          `discovering the organization of ${slug(home)}`,
          credential,
          err,
        ).message,
      };
    }
  }

  return {
    fields,
    own,
    read,
    createInput,
    updateInput,
    touches,
    detect,
    async report() {
      const out: CoreFacetReport["facets"] = {};
      for (const f of ["type", "priority", "size"] as const) {
        const s = facets[f];
        if (usable(s) && s.why === "configured" && s.store !== "label")
          out[f] = { health: await health(s) };
      }
      const unnamed = (["type", "priority", "size"] as const).filter((f) => {
        const s = facets[f];
        return usable(s) && s.why !== "configured";
      });
      if (unnamed.length > 0) {
        const found = await detectAll(unnamed);
        for (const f of unnamed)
          out[f] = { ...out[f], detection: found[f] as FacetDetection };
      }
      return { facets: out, discovery: await discover() };
    },
  };

  /** Detection for every facet not named; a failed read fails each with its error. */
  async function detectAll(
    unnamed: Facet[],
  ): Promise<Partial<Record<Facet, FacetDetection>>> {
    try {
      return await detect(unnamed);
    } catch (err) {
      // A transport failure arrives as one line already; a shape error
      // names the field it could not read, never a body.
      const failure =
        err instanceof GitHubApiError
          ? err
          : facetFailure(`detection read of ${slug(home)}`, credential, err);
      return Object.fromEntries(
        unnamed.map((f) => [
          f,
          {
            status: "failed",
            error: failure.message,
            unavailable: failure.unavailable,
          },
        ]),
      );
    }
  }

  /** The labels of a facet the configuration does not name. */
  function labelsOf(f: Facet): string[] {
    if (f === "priority") return [...model.priorityLabels];
    const s = facets[f];
    return usable(s) ? (s.labels ?? []).flatMap(([, ls]) => ls) : [];
  }

  /**
   * What the GitHub default would select for each facet in `unnamed`. Throws
   * on a failed read: a denied, rate-limited or timed-out read never reads as
   * "no field".
   */
  async function detect(
    unnamed: Facet[],
  ): Promise<Partial<Record<Facet, FacetDetection>>> {
    const counted = (q: string) => `${q} { totalCount }`;
    const labelCounts = unnamed
      .filter((f) => labelsOf(f).length > 0)
      .map((f) =>
        counted(
          `l_${f}: issues(filterBy: { labels: ${JSON.stringify(labelsOf(f))} })`,
        ),
      );
    const first = await ask(`
      query TrackerFacetEvidence($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          issueTypes(first: 100) { pageInfo { hasNextPage } nodes { id name } }
          issueFields(first: 100) { pageInfo { hasNextPage } ${FIELD_DEFS} }
          ${labelCounts.join("\n")}
        }
      }`);
    const types = typeNodes(first.issueTypes, "repository.issueTypes").map(
      (t) => t.name,
    );
    const defs = fieldDefs(first.issueFields, "repository.issueFields");
    const candidates = new Map<
      Facet,
      { evidence: string[]; candidate: Evidence["candidate"]; problem?: string }
    >();
    for (const f of unnamed) candidates.set(f, candidateOf(f, types, defs));
    const nativeCounts = [...candidates.entries()].flatMap(([f, c]) =>
      c.evidence.map((filter, i) =>
        counted(`n_${f}_${i}: issues(filterBy: ${filter})`),
      ),
    );
    const second =
      nativeCounts.length === 0
        ? {}
        : await ask(`
      query TrackerFacetNativeEvidence($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { ${nativeCounts.join("\n")} }
      }`);
    const count = (r: Record<string, unknown>, key: string) => {
      const total = record(r[key], key).totalCount;
      if (!Number.isInteger(total) || (total as number) < 0)
        throw new GitHubApiError(`${key}.totalCount: unreadable`);
      return total as number;
    };
    const out: Partial<Record<Facet, FacetDetection>> = {};
    for (const f of unnamed) {
      const c = candidates.get(f) as {
        evidence: string[];
        candidate: Evidence["candidate"];
        problem?: string;
      };
      out[f] = detection({
        labelEvidence: labelsOf(f).length > 0 && count(first, `l_${f}`) > 0,
        nativeEvidence: c.evidence.some(
          (_, i) => count(second, `n_${f}_${i}`) > 0,
        ),
        candidate: c.candidate,
        ...(c.problem === undefined ? {} : { candidateProblem: c.problem }),
      });
    }
    return out;
  }

  async function ask(query: string): Promise<Record<string, unknown>> {
    try {
      return record(
        record(await transport(query, repo), "data").repository,
        "repository",
      );
    } catch (err) {
      throw facetFailure(`detection read of ${slug(home)}`, credential, err);
    }
  }

  /**
   * The store a facet could move to, and the filters that find a value
   * already written there (native evidence).
   */
  function candidateOf(
    f: Facet,
    types: string[],
    defs: FieldDef[],
  ): {
    evidence: string[];
    candidate: Evidence["candidate"];
    problem?: string;
  } {
    const s = facets[f];
    const values = usable(s) ? s.values : [];
    if (f === "type") {
      const named = values.filter((v) => types.some((t) => same(t, v)));
      // Evidence counts every populated issue type, not only the canonical ones.
      const missing = values.filter((v) => !named.includes(v));
      return {
        evidence: types.map((t) => `{ type: ${JSON.stringify(t)} }`),
        candidate: types.length === 0 ? null : { store: "native" },
        ...(missing.length === 0 || types.length === 0
          ? {}
          : {
              problem: `no issue type is named ${missing.join(", ")}; such a type is refused when filed unless issue_tracker.facets.type.values names its issue type`,
            }),
      };
    }
    const name = f === "priority" ? "Priority" : "Effort";
    const field = defs.find(
      (d) => same(d.name, name) && d.dataType === "SINGLE_SELECT",
    );
    if (field === undefined) return { evidence: [], candidate: null };
    const evidence = field.options.map(
      (o) =>
        `{ issueFieldValues: [{ fieldName: ${JSON.stringify(field.name)}, singleSelectOptionValue: ${JSON.stringify(o.name)} }] }`,
    );
    const wanted = f === "priority" ? [...PRIORITY_NAMES] : values;
    const matches =
      wanted.length === field.options.length &&
      wanted.every((v) => field.options.some((o) => same(o.name, v)));
    if (matches)
      return {
        evidence,
        candidate:
          f === "priority"
            ? { store: "native", field: field.name }
            : { store: "field", field: field.name },
      };
    return {
      evidence,
      candidate: null,
      problem: `the ${field.name} field's options (${field.options.map((o) => o.name).join(", ")}) are not the ${f === "priority" ? "priorities" : "sizes"} (${wanted.join(", ")}); name them in issue_tracker.facets.${f}.values, or keep ${f} in labels (store: label)`,
    };
  }
}
