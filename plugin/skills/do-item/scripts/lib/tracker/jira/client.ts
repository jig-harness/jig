/**
 * The Jira adapter's requests: one issue, a JQL listing, an issue's comments
 * and changelog, and the resolvers that turn a configured or given name into
 * the one Jira resource it names (a fix version, a priority, a link type, an
 * issue type, a field read as labels, a user), and the clause that limits a
 * pool to the configured issue types. `tracker.ts`, `reports.ts`
 * and `assigner.ts` build the port on these.
 *
 * A name that resolves to no resource, or to several, is refused before
 * anything is written. Timestamps are read in Jira's `+0000` form and given
 * on as ISO 8601 in UTC.
 */

import { cancellableRequest } from "../cancellation.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";
import { defaultFacets, type Facets } from "../facets/config.ts";
import { TrackerRequestError } from "../port.ts";
import { adfToMarkdown } from "./adf.ts";
import { type BlockedField, resolveBlockedFields } from "./blocked-fields.ts";
import {
  type FacetField,
  facetFieldStores,
  resolveFacetFields,
  type SiteField,
} from "./facets.ts";
import {
  FIELDS,
  type FieldLabel,
  iso,
  type JiraIssue,
  optStr,
  parseIssue,
  record,
  stateInputOf,
  str,
} from "./read.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
import { KEY, ORDER, openClause, quote } from "./jql.ts";
import type { JiraModel } from "./model.ts";
import type { JiraSettings, LinkedRelation } from "./settings.ts";
import {
  abortedError,
  JiraApiError,
  JIRA_CREDENTIAL_HELP,
  type JiraTransport,
  offsetPages,
  searchPages,
} from "./transport.ts";

/** One comment, with its author. */
export interface JiraComment {
  id: string;
  body: string;
  createdAt: string;
  /** `null` for a deleted account. */
  author: Record<string, unknown> | null;
}

export interface ChangelogEntry {
  createdAt: string;
  author: Record<string, unknown> | null;
  items: Array<{
    fieldId: string;
    from: string | null;
    to: string | null;
    /** Whether the tracker stated both sides; an absent side is not `null`. */
    explicit: boolean;
  }>;
}

/** A link type the configuration names, with the words for its two sides. */
export interface LinkType {
  name: string;
  inward: string;
  outward: string;
}

/** One link type a relation is carried by, resolved against the site. */
export interface RelationLink extends LinkType {
  /** The type's outward side reads as the relation's inverse. */
  inverted: boolean;
}

export interface IssueTypeMeta {
  id: string;
  name: string;
  subtask: boolean;
  level: number;
  /** False when the metadata gave no hierarchy level and `level` is a guess. */
  levelKnown: boolean;
}

export interface Client {
  readonly project: string;
  readonly site: string;
  readonly model: JiraModel;
  readonly settings: JiraSettings;
  readonly transport: JiraTransport;
  /** The repository's facets, resolved. */
  readonly facets: Facets;
  /** Verify the credential identifies an account before a protected read. */
  authenticate(signal?: AbortSignal): Promise<void>;
  /** One issue; `null` when it does not exist or is not visible. */
  issue(key: string, signal?: AbortSignal): Promise<JiraIssue | null>;
  /** One issue that must exist. */
  mustIssue(key: string, signal?: AbortSignal): Promise<JiraIssue>;
  /** Every issue a JQL query selects. */
  search(
    jql: string,
    where: string,
    signal?: AbortSignal,
    fields?: ReadonlyArray<string>,
  ): Promise<JiraIssue[]>;
  /**
   * How many issues a JQL query selects that the model reads as open, from
   * each issue's status, type and resolution alone: no field or facet is
   * resolved and no issue parsed. An unreadable status throws.
   */
  countOpen(jql: string, where: string, signal?: AbortSignal): Promise<number>;
  /** The issue's children: its sub-tasks, or an Epic's issues. */
  children(
    key: string,
    open?: boolean,
    signal?: AbortSignal,
  ): Promise<JiraIssue[]>;
  /** Every comment on an issue, oldest first. */
  comments(key: string, signal?: AbortSignal): Promise<JiraComment[]>;
  /** Every changelog entry of an issue. */
  changelog(key: string): Promise<ChangelogEntry[]>;
  /** A fix version of the project by its name; its id. */
  version(name: string, signal?: AbortSignal): Promise<string>;
  /** A priority by its name; its id. */
  priority(name: string, signal?: AbortSignal): Promise<string>;
  /**
   * Each relation's configured link types, each resolved to exactly one of
   * the site's, the type a new link gets first.
   */
  linkTypes(): Promise<Record<LinkedRelation, RelationLink[]>>;
  /** The project's issue types, with their hierarchy level. */
  issueTypes(signal?: AbortSignal): Promise<IssueTypeMeta[]>;
  /**
   * The JQL clause limiting a pool to `issue_tracker.jira.pool_issue_types`,
   * each name resolved to one of the project's issue types; `null`, and no
   * request, when none is configured.
   */
  poolScope(signal?: AbortSignal): Promise<string | null>;
  /**
   * The fields `issue_tracker.jira.field_labels` names, each resolved to
   * exactly one field of the site; read once, and without a request when
   * none is configured. An aborted `signal` ends the wait, not the shared
   * read other callers may be waiting on.
   */
  fieldLabels(signal?: AbortSignal): Promise<FieldLabel[]>;
  /**
   * The custom fields `issue_tracker.facets` keeps a facet in, each resolved
   * to exactly one field of the site; read once, and without a request when
   * no facet is kept in one.
   */
  facetFields(signal?: AbortSignal): Promise<FacetField[]>;
  /**
   * The fields `issue_tracker.jira.blocked_fields` names, each resolved to
   * exactly one field of the site; read once, and without a request when
   * none is configured.
   */
  blockedFields(): Promise<BlockedField[]>;
  /**
   * The fields on the create screen of an issue type of the project, each
   * with the values it allows (`null` where it lists none); read once per
   * issue type.
   */
  createMeta(issueTypeId: string, signal?: AbortSignal): Promise<FieldMeta>;
  /** The fields an issue's edit screen has, each with the values it allows. */
  editMeta(key: string, signal?: AbortSignal): Promise<FieldMeta>;
  /**
   * The account id an identity (account id, email or display name) names.
   * An aborted `signal` ends the request in flight and the pages not yet read.
   */
  accountId(identity: string, signal?: AbortSignal): Promise<string>;
  /** Whether the account can be assigned issues in the project; cached. */
  assignable(accountId: string): Promise<boolean>;
  /** Whether a user (a comment author, an assigner) is trusted. */
  trusted(user: Record<string, unknown> | null): Promise<boolean>;
  /** The credential's profile time zone, read once. */
  timeZone(): Promise<string>;
}

/** A screen's fields by id, each with the values it allows (`null`: no list). */
export type FieldMeta = ReadonlyMap<string, string[] | null>;

/** The allowed values of one field's metadata, by their names. */
function allowedOf(meta: unknown): string[] | null {
  if (!isRecord(meta) || !Array.isArray(meta.allowedValues)) return null;
  return meta.allowedValues.flatMap((v) => {
    const name = isRecord(v) ? (v.value ?? v.name) : v;
    return typeof name === "string" ? [name] : [];
  });
}

/** An Atlassian account id: the 24-hex form or the `<n>:<uuid>` form. */
const ACCOUNT_ID = /^(?:[0-9a-f]{24}|\d+:[0-9a-f-]{36})$/;

type Get = (
  path: string,
  query?: Record<string, string | number>,
  signal?: AbortSignal,
) => Promise<unknown>;

/** An account id, confirmed to name a user. */
async function confirmAccount(
  get: Get,
  who: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const u = record(
      await get("user", { accountId: who }, signal),
      `user ${who}`,
    );
    return str(u.accountId, `user ${who}.accountId`);
  } catch (err) {
    if (err instanceof JiraApiError && err.notFound)
      throw new TrackerRequestError(
        "unresolved",
        `no Jira user has the account id ${who}`,
      );
    throw err;
  }
}

/** Every user a user search for `who` finds, page by page. */
async function searchUsers(
  get: Get,
  who: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const users: Record<string, unknown>[] = [];
  for (let startAt = 0; ; startAt += USERS_PAGE) {
    const page = await get(
      "user/search",
      { query: who, startAt, maxResults: USERS_PAGE },
      signal,
    );
    if (!Array.isArray(page))
      throw new JiraApiError(`user search for '${who}': expected a list`);
    users.push(
      ...page.map((u, i) => record(u, `user search for '${who}'[${i}]`)),
    );
    if (users.length >= USERS_CEILING)
      throw new TrackerRequestError(
        "unresolved",
        `Jira user search for '${who}' reached its ${USERS_CEILING}-account ceiling, so its matches are not a complete census; name the account by its id`,
      );
    if (page.length < USERS_PAGE) return users;
  }
}

/** The one account whose email or display name is `who`, ignoring case. */
async function searchAccount(
  get: Get,
  who: string,
  signal?: AbortSignal,
): Promise<string> {
  const named = (v: unknown) => typeof v === "string" && same(v, who);
  const ids = new Set(
    (await searchUsers(get, who, signal))
      .filter((u) => named(u.emailAddress) || named(u.displayName))
      .map((u) => str(u.accountId, "user.accountId")),
  );
  if (ids.size === 1) return [...ids][0] as string;
  throw new TrackerRequestError(
    "unresolved",
    ids.size === 0
      ? `no Jira user has the email or display name '${who}' (an email is matched only when the account shares it); name the account by its id`
      : `${ids.size} Jira users have the email or display name '${who}'; name the account by its id`,
  );
}

/** A field's JQL clause name: `cf[10050]` for `customfield_10050`, else its id. */
function clauseOf(id: string): string {
  const custom = /^customfield_(\d+)$/.exec(id);
  return custom === null ? id : `cf[${custom[1]}]`;
}

/** Whether the schema is a multiline custom field, the description or the environment: Jira returns them as ADF documents. */
function holdsRichText(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const { custom, system } = schema;
  return (
    (typeof custom === "string" && custom.endsWith(":textarea")) ||
    system === "description" ||
    system === "environment"
  );
}

/**
 * How JQL matches one value of a field of this schema exactly, or a refusal
 * for a type whose values do not read as labels (a user, a date, a
 * cascading select).
 */
function matchOf(
  schema: unknown,
  at: string,
  name: string,
): FieldLabel["match"] {
  const type = isRecord(schema) ? schema.type : undefined;
  const items = isRecord(schema) ? schema.items : undefined;
  if (holdsRichText(schema))
    throw new TrackerConfigError(
      at,
      `${at}: the field '${name}' holds rich text, which does not read as a label; only single-line text, number, select, checkbox, labels and version fields do`,
    );
  if (type === "string") return null;
  if (type === "number") return "number";
  if (type === "option") return "string";
  // A version field (Fix versions, Affects versions, a version picker): each
  // version by its name, which JQL matches as a quoted string.
  if (type === "version") return "string";
  if (
    type === "array" &&
    (items === "option" || items === "string" || items === "version")
  )
    return "string";
  throw new TrackerConfigError(
    at,
    `${at}: the field '${name}' is of type ${JSON.stringify(type)}${items === undefined ? "" : ` of ${JSON.stringify(items)}`}; only single-line text, number, select, checkbox, labels and version fields read as labels`,
  );
}

/** The page size of a user search. */
const USERS_PAGE = 50;

/** Jira documents at most this many accounts per user search. */
const USERS_CEILING = 1000;

export interface ClientOptions {
  project: string;
  site: string;
  model: JiraModel;
  settings: JiraSettings;
  transport: JiraTransport;
  /** The repository's facets; default: every facet at the adapter's default. */
  facets?: Facets;
}

/** `promise`, or a refusal as soon as `signal` aborts; the promise itself runs on. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/**
 * One read shared by its callers. It runs under a controller of its own, which
 * aborts the read in flight once every caller holding a signal has given up
 * (a caller with none keeps it running); a failed or abandoned read is
 * forgotten, so the next caller starts afresh.
 */
function sharedRead<T>(run: (signal: AbortSignal) => Promise<T>) {
  interface Op {
    promise: Promise<T>;
    control: AbortController;
    waiters: number;
    done: boolean;
  }
  let op: Op | undefined;
  return (signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted === true) return Promise.reject(abortedError(signal));
    if (op === undefined) {
      const control = new AbortController();
      const started: Op = {
        promise: run(control.signal),
        control,
        waiters: 0,
        done: false,
      };
      op = started;
      started.promise.then(
        () => {
          started.done = true;
        },
        () => {
          started.done = true;
          if (op === started) op = undefined;
        },
      );
    }
    const current = op;
    current.waiters++;
    if (signal === undefined || current.done) return current.promise;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        current.waiters--;
        if (current.waiters === 0 && !current.done) {
          current.control.abort(signal.reason);
          if (op === current) op = undefined;
        }
        reject(abortedError(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      current.promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  };
}

export function jiraClient(opts: ClientOptions): Client {
  const { project, site, model, settings } = opts;
  const transport: JiraTransport = (request, signal) =>
    cancellableRequest(signal, () => opts.transport(request, signal));
  const get: Get = (path, query, signal) =>
    transport(
      {
        method: "GET",
        path,
        ...(query === undefined ? {} : { query }),
      },
      signal,
    );

  let links: Promise<Record<LinkedRelation, RelationLink[]>> | undefined;
  let labelFields: Promise<FieldLabel[]> | undefined;
  let allFields: Promise<SiteField[]> | undefined;
  let storeFields: Promise<FacetField[]> | undefined;
  let stateFields: Promise<BlockedField[]> | undefined;
  const readTypes = sharedRead(async (own): Promise<IssueTypeMeta[]> => {
    const values = await offsetPages(
      transport,
      { method: "GET", path: `issue/createmeta/${project}/issuetypes` },
      {
        items: "issueTypes",
        idOf: (t) => t.id,
        where: `issue types of ${project}`,
        signal: own,
      },
    );
    return values.map((t) => ({
      id: String(t.id),
      name: str(t.name, "issueType.name"),
      subtask: t.subtask === true,
      level:
        typeof t.hierarchyLevel === "number"
          ? t.hierarchyLevel
          : t.subtask === true
            ? -1
            : 0,
      levelKnown: typeof t.hierarchyLevel === "number" || t.subtask === true,
    }));
  });
  const createScreens = new Map<
    string,
    (signal?: AbortSignal) => Promise<FieldMeta>
  >();
  let zone: Promise<string> | undefined;
  let me: Promise<Record<string, unknown>> | undefined;
  const assignables = new Map<string, Promise<boolean>>();

  /** The credential's own profile, read once. */
  function myself(): Promise<Record<string, unknown>> {
    me ??= (async () => {
      const raw = await get("myself");
      const profile = record(raw, "myself");
      if (typeof profile.accountId !== "string" || !profile.accountId.trim())
        throw new JiraApiError(
          `Jira did not identify an authenticated account; ${JIRA_CREDENTIAL_HELP}`,
        );
      return profile;
    })();
    me.catch(() => {
      me = undefined;
    });
    return me;
  }

  /** Exactly one of `items` named `name`, or a refusal saying how many. */
  function onlyNamed<T extends { name: string }>(
    items: T[],
    name: string,
    what: string,
  ): T {
    const matches = items.filter((i) => same(i.name, name));
    if (matches.length !== 1)
      throw new TrackerRequestError(
        "unresolved",
        `'${name}' matches ${matches.length} ${what}, expected exactly 1`,
      );
    return matches[0] as T;
  }

  /** The fields every issue read asks for, with those read as labels or as a facet. */
  async function fieldsToRead(signal?: AbortSignal): Promise<string[]> {
    const extra = [
      ...(await client.fieldLabels(signal)).map((f) => f.id),
      ...(await client.facetFields(signal)).map((f) => f.id),
    ];
    return [...FIELDS, ...new Set(extra)];
  }

  /** The site's fields, read once for every resolver that needs them. */
  function siteFields(): Promise<SiteField[]> {
    allFields ??= (async () => {
      await myself();
      const raw = await get("field");
      if (!Array.isArray(raw))
        throw new JiraApiError("fields of the site: expected a list");
      return raw.map((f, i) => {
        const r = record(f, `fields[${i}]`);
        const clauseNames = Array.isArray(r.clauseNames)
          ? r.clauseNames.filter((c): c is string => typeof c === "string")
          : [];
        return {
          id: str(r.id, `fields[${i}].id`),
          name: str(r.name, `fields[${i}].name`),
          schema: r.schema,
          ...(clauseNames.length === 0 ? {} : { clauseNames }),
        };
      });
    })();
    allFields.catch(() => {
      allFields = undefined;
    });
    return allFields;
  }

  /** One screen's fields from a metadata answer: a list of fields, or a map by id. */
  function metaOf(fields: unknown, where: string): FieldMeta {
    const out = new Map<string, string[] | null>();
    if (Array.isArray(fields))
      for (const [i, f] of fields.entries()) {
        const r = record(f, `${where}[${i}]`);
        out.set(
          str(r.fieldId ?? r.key, `${where}[${i}].fieldId`),
          allowedOf(r),
        );
      }
    else
      for (const [id, f] of Object.entries(record(fields, where)))
        out.set(id, allowedOf(f));
    return out;
  }

  const client: Client = {
    project,
    site,
    model,
    settings,
    transport,
    facets: opts.facets ?? defaultFacets("jira"),

    async authenticate(signal) {
      if (signal?.aborted === true) throw abortedError(signal);
      const authenticated = myself();
      await (signal === undefined
        ? authenticated
        : until(authenticated, signal));
    },

    async issue(key, signal) {
      if (signal?.aborted === true) throw abortedError(signal);
      const authenticated = myself();
      await (signal === undefined
        ? authenticated
        : until(authenticated, signal));
      // Resolved before the issue's own 404 handler: a failed field read is
      // not a missing issue.
      const read = (await fieldsToRead(signal)).join(",");
      let raw: unknown;
      try {
        raw = await transport(
          {
            method: "GET",
            path: `issue/${encodeURIComponent(key)}`,
            query: { fields: read },
          },
          signal,
        );
      } catch (err) {
        if (err instanceof JiraApiError && err.notFound) return null;
        throw err;
      }
      return parseIssue(
        raw,
        site,
        await client.fieldLabels(signal),
        await client.facetFields(signal),
      );
    },

    async mustIssue(key, signal) {
      const found = await client.issue(key, signal);
      if (found === null)
        throw new TrackerRequestError(
          "unresolved",
          `issue ${key} does not exist in Jira, or is not visible`,
        );
      return found;
    },

    async search(jql, where, signal, fields) {
      if (signal?.aborted === true) throw abortedError(signal);
      const authenticated = myself();
      await (signal === undefined
        ? authenticated
        : until(authenticated, signal));
      const extra = await client.fieldLabels(signal);
      const facet = await client.facetFields(signal);
      const read = fields ?? (await fieldsToRead(signal));
      return (await searchPages(transport, jql, read, where, signal)).map((i) =>
        parseIssue(i, site, extra, facet),
      );
    },

    async countOpen(jql, where, signal) {
      if (signal?.aborted === true) throw abortedError(signal);
      const authenticated = myself();
      await (signal === undefined
        ? authenticated
        : until(authenticated, signal));
      const read = await searchPages(
        transport,
        jql,
        ["status", "issuetype", "resolution"],
        where,
        signal,
      );
      return read.filter(
        (i) =>
          !["completed", "canceled", "duplicate"].includes(
            model.read(stateInputOf(i)).state.type,
          ),
      ).length;
    },

    children(key, open = false, signal) {
      if (!KEY.test(key))
        throw new TrackerRequestError(
          "invalid",
          `not a Jira issue key: ${key}`,
        );
      // No project clause: an Epic's children may live in other projects.
      return client
        .search(
          `${[`parent = ${key}`, ...(open ? [openClause(model.stateNames("blocked"))] : [])].join(" AND ")}${ORDER}`,
          `children of ${key}`,
          signal,
        )
        .then((issues) =>
          open
            ? issues.filter(
                (issue) =>
                  !["completed", "canceled", "duplicate"].includes(
                    model.read(issue).state.type,
                  ),
              )
            : issues,
        );
    },

    async comments(key, signal) {
      const items = await offsetPages(
        transport,
        {
          method: "GET",
          path: `issue/${encodeURIComponent(key)}/comment`,
          query: { orderBy: "created" },
        },
        {
          items: "comments",
          idOf: (c) => c.id,
          where: `comments of ${key}`,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return items
        .map((c, i) => ({
          id: String(c.id ?? i),
          body: adfToMarkdown(c.body),
          createdAt: iso(c.created, `comments of ${key}[${i}].created`),
          author: isRecord(c.author) ? c.author : null,
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async changelog(key) {
      const values = await offsetPages(
        transport,
        { method: "GET", path: `issue/${encodeURIComponent(key)}/changelog` },
        { items: "values", idOf: (v) => v.id, where: `changelog of ${key}` },
      );
      return values.map((v, i) => {
        const where = `changelog of ${key}[${i}]`;
        if (!Array.isArray(v.items))
          throw new JiraApiError(`${where}: items missing`);
        return {
          createdAt: iso(v.created, `${where}.created`),
          author: isRecord(v.author) ? v.author : null,
          items: v.items.map((it, j) => {
            const item = record(it, `${where}.items[${j}]`);
            return {
              fieldId: String(item.fieldId ?? item.field ?? ""),
              from: optStr(item.from, `${where}.items[${j}].from`),
              to: optStr(item.to, `${where}.items[${j}].to`),
              explicit: item.from !== undefined && item.to !== undefined,
            };
          }),
        };
      });
    },

    async version(name, signal) {
      const raw = await get(`project/${project}/versions`, undefined, signal);
      if (!Array.isArray(raw))
        throw new JiraApiError(`versions of ${project}: expected a list`);
      const versions = raw.map((v, i) => {
        const r = record(v, `versions of ${project}[${i}]`);
        return { id: String(r.id), name: str(r.name, "version.name") };
      });
      return onlyNamed(versions, name, `fix versions of ${project}`).id;
    },

    async priority(name, signal) {
      const values = await offsetPages(
        transport,
        { method: "GET", path: "priority/search" },
        {
          items: "values",
          idOf: (p) => p.id,
          where: "priorities",
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const priorities = values.map((p) => ({
        id: String(p.id),
        name: str(p.name, "priority.name"),
      }));
      return onlyNamed(priorities, name, "priorities").id;
    },

    linkTypes() {
      links ??= (async () => {
        const raw = record(await get("issueLinkType"), "issueLinkType");
        if (!Array.isArray(raw.issueLinkTypes))
          throw new JiraApiError("issueLinkType: issueLinkTypes missing");
        const all = raw.issueLinkTypes.map((t, i) => {
          const r = record(t, `issueLinkTypes[${i}]`);
          return {
            name: str(r.name, "linkType.name"),
            inward: optStr(r.inward, "linkType.inward") ?? "",
            outward: optStr(r.outward, "linkType.outward") ?? "",
          };
        });
        const out = {} as Record<LinkedRelation, RelationLink[]>;
        for (const [relation, entries] of Object.entries(settings.linkTypes))
          out[relation as LinkedRelation] = entries.map(
            ({ name, inverted }) => {
              const matches = all.filter((t) => same(t.name, name));
              if (matches.length !== 1)
                throw new TrackerConfigError(
                  `issue_tracker.jira.link_types.${relation}`,
                  `issue_tracker.jira.link_types.${relation} names '${name}', which matches ${matches.length} issue link types of the site (${all.map((t) => t.name).join(", ")}), expected exactly 1`,
                );
              return { ...(matches[0] as LinkType), inverted };
            },
          );
        return out;
      })();
      links.catch(() => {
        links = undefined;
      });
      return links;
    },

    issueTypes(signal) {
      return readTypes(signal);
    },

    async poolScope(signal) {
      const wanted = settings.poolIssueTypes;
      if (wanted.length === 0) return null;
      const types = await readTypes(signal);
      const ids = wanted.map((name) => {
        const matches = types.filter((t) => same(t.name, name));
        if (matches.length !== 1)
          throw new TrackerConfigError(
            "issue_tracker.jira.pool_issue_types",
            `issue_tracker.jira.pool_issue_types names '${name}', which matches ${matches.length} issue types of project ${project} (${types.map((t) => t.name).join(", ") || "none"}), expected exactly 1`,
          );
        // By id, so a type renamed later still matches; a name, quoted,
        // where the metadata gave no numeric id.
        const found = matches[0] as IssueTypeMeta;
        return /^\d+$/.test(found.id) ? found.id : quote(found.name);
      });
      return `issuetype in (${ids.join(", ")})`;
    },

    fieldLabels(signal) {
      const configured = Object.entries(settings.fieldLabels);
      if (configured.length === 0) return Promise.resolve([]);
      if (signal?.aborted === true) return Promise.reject(abortedError(signal));
      labelFields ??= (async () => {
        const all = await siteFields();
        return configured.map(([name, prefix]) => {
          const at = `issue_tracker.jira.field_labels.${name}`;
          const byId = all.filter((f) => f.id === name);
          const matches =
            byId.length > 0 ? byId : all.filter((f) => same(f.name, name));
          if (matches.length !== 1)
            throw new TrackerConfigError(
              at,
              `${at}: '${name}' matches ${matches.length} fields of the site${matches.length > 1 ? ` (${matches.map((f) => f.id).join(", ")}); name the field by its id` : ""}, expected exactly 1`,
            );
          const f = matches[0] as (typeof all)[number];
          return {
            configured: name,
            id: f.id,
            name: f.name,
            // A system field's JQL name can differ from its id
            // (`fixVersion` for `fixVersions`); a custom field's is cf[n].
            clause: f.id.startsWith("customfield_")
              ? clauseOf(f.id)
              : (f.clauseNames?.[0] ?? f.id),
            prefix,
            match: matchOf(f.schema, at, f.name),
          };
        });
      })();
      labelFields.catch(() => {
        labelFields = undefined;
      });
      return signal === undefined ? labelFields : until(labelFields, signal);
    },

    facetFields(signal) {
      const stores = facetFieldStores(client.facets);
      if (stores.length === 0) return Promise.resolve([]);
      if (signal?.aborted === true) return Promise.reject(abortedError(signal));
      storeFields ??= (async () =>
        resolveFacetFields(stores, await siteFields()))();
      storeFields.catch(() => {
        storeFields = undefined;
      });
      return signal === undefined ? storeFields : until(storeFields, signal);
    },

    blockedFields() {
      const names = settings.blockedFields;
      if (names.reason === null && names.since === null)
        return Promise.resolve([]);
      stateFields ??= (async () =>
        resolveBlockedFields(names, await siteFields()))();
      stateFields.catch(() => {
        stateFields = undefined;
      });
      return stateFields;
    },

    createMeta(issueTypeId, signal) {
      let read = createScreens.get(issueTypeId);
      if (read === undefined) {
        const where = `create screen of issue type ${issueTypeId} in ${project}`;
        read = sharedRead(async (own) =>
          metaOf(
            await offsetPages(
              transport,
              {
                method: "GET",
                path: `issue/createmeta/${project}/issuetypes/${encodeURIComponent(issueTypeId)}`,
              },
              {
                items: "fields",
                idOf: (f) => f.fieldId,
                where,
                signal: own,
              },
            ),
            where,
          ),
        );
        createScreens.set(issueTypeId, read);
      }
      return read(signal);
    },

    async editMeta(key, signal) {
      const raw = record(
        await get(
          `issue/${encodeURIComponent(key)}/editmeta`,
          undefined,
          signal,
        ),
        `edit screen of ${key}`,
      );
      return metaOf(raw.fields, `edit screen of ${key}.fields`);
    },

    accountId(identity, signal) {
      const who = identity.trim();
      return ACCOUNT_ID.test(who)
        ? confirmAccount(get, who, signal)
        : searchAccount(get, who, signal);
    },

    assignable(accountId) {
      let found = assignables.get(accountId);
      if (found === undefined) {
        found = (async () => {
          const users = await get("user/assignable/search", {
            project,
            accountId,
            maxResults: 2,
          });
          if (!Array.isArray(users))
            throw new JiraApiError(
              `assignable users of ${project}: expected a list`,
            );
          return users.some((u) => isRecord(u) && u.accountId === accountId);
        })();
        found.catch(() => assignables.delete(accountId));
        assignables.set(accountId, found);
      }
      return found;
    },

    async trusted(user) {
      if (user === null || typeof user.accountId !== "string") return false;
      if (user.accountType !== "atlassian" || user.guest === true) return false;
      return client.assignable(user.accountId);
    },

    timeZone() {
      zone ??= (async () => {
        const tz = str((await myself()).timeZone, "myself.timeZone");
        try {
          new Intl.DateTimeFormat("en", { timeZone: tz });
        } catch {
          throw new JiraApiError(`myself.timeZone: '${tz}' is not a time zone`);
        }
        return tz;
      })();
      zone.catch(() => {
        zone = undefined;
      });
      return zone;
    },
  };
  return client;
}
