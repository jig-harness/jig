/**
 * The Jira adapter's requests: one issue, a JQL listing, an issue's comments
 * and changelog, and the resolvers that turn a configured or given name into
 * the one Jira resource it names (a fix version, a priority, a link type, an
 * issue type, a user). `tracker.ts`, `reports.ts` and `assigner.ts` build
 * the port on these.
 *
 * A name that resolves to no resource, or to several, is refused before
 * anything is written. Timestamps are read in Jira's `+0000` form and given
 * on as ISO 8601 in UTC.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";
import { TrackerRequestError } from "../port.ts";
import { adfToMarkdown } from "./adf.ts";
import {
  FIELDS,
  iso,
  type JiraIssue,
  optStr,
  parseIssue,
  record,
  str,
} from "./read.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
import { ORDER, OPEN } from "./jql.ts";
import type { JiraModel } from "./model.ts";
import type { JiraSettings, LinkedRelation } from "./settings.ts";
import {
  JiraApiError,
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
  items: Array<{ fieldId: string; to: string | null }>;
}

/** A link type the configuration names, with the words for its two sides. */
export interface LinkType {
  name: string;
  inward: string;
  outward: string;
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
  version(name: string): Promise<string>;
  /** A priority by its name; its id. */
  priority(name: string): Promise<string>;
  /** The configured link types, each resolved to exactly one. */
  linkTypes(): Promise<Record<LinkedRelation, LinkType>>;
  /** The project's issue types, with their hierarchy level. */
  issueTypes(): Promise<IssueTypeMeta[]>;
  /** The account id an identity (account id, email or display name) names. */
  accountId(identity: string): Promise<string>;
  /** Whether the account can be assigned issues in the project; cached. */
  assignable(accountId: string): Promise<boolean>;
  /** Whether a user (a comment author, an assigner) is trusted. */
  trusted(user: Record<string, unknown> | null): Promise<boolean>;
  /** The credential's profile time zone, read once. */
  timeZone(): Promise<string>;
  /** The credential's own account id, read once. */
  selfId(): Promise<string>;
}

/** An Atlassian account id: the 24-hex form or the `<n>:<uuid>` form. */
const ACCOUNT_ID = /^(?:[0-9a-f]{24}|\d+:[0-9a-f-]{36})$/;

type Get = (
  path: string,
  query?: Record<string, string | number>,
) => Promise<unknown>;

/** An account id, confirmed to name a user. */
async function confirmAccount(get: Get, who: string): Promise<string> {
  try {
    const u = record(await get("user", { accountId: who }), `user ${who}`);
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
): Promise<Record<string, unknown>[]> {
  const users: Record<string, unknown>[] = [];
  for (let startAt = 0; ; startAt += USERS_PAGE) {
    const page = await get("user/search", {
      query: who,
      startAt,
      maxResults: USERS_PAGE,
    });
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
async function searchAccount(get: Get, who: string): Promise<string> {
  const named = (v: unknown) => typeof v === "string" && same(v, who);
  const ids = new Set(
    (await searchUsers(get, who))
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
}

export function jiraClient(opts: ClientOptions): Client {
  const { project, site, model, settings, transport } = opts;
  const get = (path: string, query?: Record<string, string | number>) =>
    transport({
      method: "GET",
      path,
      ...(query === undefined ? {} : { query }),
    });

  let links: Promise<Record<LinkedRelation, LinkType>> | undefined;
  let types: Promise<IssueTypeMeta[]> | undefined;
  let zone: Promise<string> | undefined;
  let me: Promise<Record<string, unknown>> | undefined;
  const assignables = new Map<string, Promise<boolean>>();
  const editors = new Map<string, Promise<boolean>>();

  /** The credential's own profile, read once. */
  function myself(): Promise<Record<string, unknown>> {
    me ??= (async () => record(await get("myself"), "myself"))();
    me.catch(() => {
      me = undefined;
    });
    return me;
  }

  /**
   * Whether the account holds the Edit Issues permission in the project;
   * cached per account. Jira answers this search only to a credential with
   * Administer Projects in the project, or Administer Jira.
   */
  function canEdit(accountId: string): Promise<boolean> {
    let found = editors.get(accountId);
    if (found === undefined) {
      found = (async () => {
        let users: unknown;
        try {
          users = await get("user/permission/search", {
            accountId,
            projectKey: project,
            permissions: "EDIT_ISSUES",
            maxResults: 2,
          });
        } catch (err) {
          if (err instanceof JiraApiError && err.status === 403)
            throw new JiraApiError(
              `Jira refused the edit-permission check of ${accountId} in ${project}: the credential needs the Administer Projects permission in the project, or Administer Jira`,
              { status: 403 },
            );
          throw err;
        }
        if (!Array.isArray(users))
          throw new JiraApiError(
            `edit permission of ${accountId} in ${project}: expected a list`,
          );
        return users.some((u) => isRecord(u) && u.accountId === accountId);
      })();
      found.catch(() => editors.delete(accountId));
      editors.set(accountId, found);
    }
    return found;
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

  const client: Client = {
    project,
    site,
    model,
    settings,
    transport,

    async issue(key, signal) {
      let raw: unknown;
      try {
        raw = await transport(
          {
            method: "GET",
            path: `issue/${encodeURIComponent(key)}`,
            query: { fields: FIELDS.join(",") },
          },
          signal,
        );
      } catch (err) {
        if (err instanceof JiraApiError && err.notFound) return null;
        throw err;
      }
      return parseIssue(raw, site);
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

    async search(jql, where, signal, fields = FIELDS) {
      return (await searchPages(transport, jql, fields, where, signal)).map(
        (i) => parseIssue(i, site),
      );
    },

    children(key, open = false, signal) {
      // No project clause: an Epic's children may live in other projects.
      return client.search(
        `${[`parent = ${key}`, ...(open ? [OPEN] : [])].join(" AND ")}${ORDER}`,
        `children of ${key}`,
        signal,
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
              to: optStr(item.to, `${where}.items[${j}].to`),
            };
          }),
        };
      });
    },

    async version(name) {
      const raw = await get(`project/${project}/versions`);
      if (!Array.isArray(raw))
        throw new JiraApiError(`versions of ${project}: expected a list`);
      const versions = raw.map((v, i) => {
        const r = record(v, `versions of ${project}[${i}]`);
        return { id: String(r.id), name: str(r.name, "version.name") };
      });
      return onlyNamed(versions, name, `fix versions of ${project}`).id;
    },

    async priority(name) {
      const values = await offsetPages(
        transport,
        { method: "GET", path: "priority/search" },
        { items: "values", idOf: (p) => p.id, where: "priorities" },
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
        const out = {} as Record<LinkedRelation, LinkType>;
        for (const [relation, name] of Object.entries(settings.linkTypes)) {
          const matches = all.filter((t) => same(t.name, name));
          if (matches.length !== 1)
            throw new TrackerConfigError(
              `issue_tracker.jira.link_types.${relation}`,
              `issue_tracker.jira.link_types.${relation} names '${name}', which matches ${matches.length} issue link types of the site (${all.map((t) => t.name).join(", ")}), expected exactly 1`,
            );
          out[relation as LinkedRelation] = matches[0] as LinkType;
        }
        return out;
      })();
      links.catch(() => {
        links = undefined;
      });
      return links;
    },

    issueTypes() {
      types ??= (async () => {
        const values = await offsetPages(
          transport,
          { method: "GET", path: `issue/createmeta/${project}/issuetypes` },
          {
            items: "issueTypes",
            idOf: (t) => t.id,
            where: `issue types of ${project}`,
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
          levelKnown:
            typeof t.hierarchyLevel === "number" || t.subtask === true,
        }));
      })();
      types.catch(() => {
        types = undefined;
      });
      return types;
    },

    accountId(identity) {
      const who = identity.trim();
      return ACCOUNT_ID.test(who)
        ? confirmAccount(get, who)
        : searchAccount(get, who);
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
      return (
        (await client.assignable(user.accountId)) &&
        (await canEdit(user.accountId))
      );
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

    async selfId() {
      return str((await myself()).accountId, "myself.accountId");
    },
  };
  return client;
}
