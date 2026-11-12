/**
 * The Jira adapter's settings, `issue_tracker.jira` in `.config/jig.yaml`:
 *
 *   jira:
 *     site: https://example.atlassian.net   # required
 *     api_base: https://api.atlassian.com/ex/jira/<cloud id>   # default: the site
 *     issue_type: Task          # the type a new issue gets
 *     subtask_type: Sub-task    # default: the project's one sub-task type
 *     priorities: { urgent: Highest, high: High, medium: Medium, low: Low }
 *     resolutions: { done: Done, canceled: Won't Do, duplicate: Duplicate }
 *     link_types: { blocks: Blocks, related: Relates, duplicate: Duplicate }
 *     field_labels: { Size: "size:" }   # a field's values read as labels
 *     pool_issue_types: [Task, Bug]     # default: every type
 *     blocked_fields: { reason: "Blocked Reason", since: "Blocked Since" }
 *
 * A priority or a resolution may list several names,
 * `urgent: [Blocker, Critical, Highest]`: each is read as that priority or
 * closed state, and the first is written.
 *
 * A relation in `link_types` may name several link types, each a name or
 * `{ name, inverted }`: `[Blocks, { name: "Depends", inverted: true }]`.
 *
 * `api_base` sends every request through Atlassian's API gateway, which a
 * scoped API token or an OAuth token calls; `site` still names the site, and
 * builds every issue's browse link. Only the gateway's host, and only its
 * Jira path for one cloud id, is accepted: `JIRA_ALLOWED_HOSTS` does not
 * widen it.
 *
 * The section is parsed whatever the adapter, so a mistyped field is refused
 * before the adapter is chosen; only the Jira adapter requires `site`.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";
import {
  firstRepeat,
  nameList,
  nonEmpty,
  refuseSharedNames,
  settingsSection,
} from "../settings-fields.ts";
import { PRIORITY_NAMES, type PriorityName } from "../github/settings.ts";

export { PRIORITY_NAMES, type PriorityName };

/** The closed states, which a resolution tells apart. */
export const RESOLVED_STATES = ["done", "canceled", "duplicate"] as const;
export type ResolvedState = (typeof RESOLVED_STATES)[number];

/** The port's relation types, each an issue link type on Jira. */
export const LINKED_RELATIONS = ["blocks", "related", "duplicate"] as const;
export type LinkedRelation = (typeof LINKED_RELATIONS)[number];

/** One link type a relation is carried by. */
export interface LinkTypeEntry {
  name: string;
  /** The type's outward side reads as the relation's inverse ("is blocked by"). */
  inverted: boolean;
}

export interface JiraSettings {
  /** `https://<name>.atlassian.net`, no trailing slash; `null` = not set. */
  site: string | null;
  /** `https://api.atlassian.com/ex/jira/<cloud id>`, no trailing slash; `null` = the site. */
  apiBase: string | null;
  issueType: string;
  /** `null` = the project's one sub-task type. */
  subtaskType: string | null;
  /** Each priority's names: every one is read as it, the first is written. */
  priorities: Record<PriorityName, string[]>;
  /** Each closed state's resolutions: every one is read as it, the first is written. */
  resolutions: Record<ResolvedState, string[]>;
  /** Each relation's link types; the first is the one a new link gets. */
  linkTypes: Record<LinkedRelation, LinkTypeEntry[]>;
  /** A field's name or id → the prefix of the labels its values become. */
  fieldLabels: Record<string, string>;
  /** The issue types every pool and population is limited to; empty = every type. */
  poolIssueTypes: string[];
  /** The fields, by name or id, a blocked item's reason and start are written to; each `null` = not written. */
  blockedFields: BlockedFieldNames;
}

/** What a blocked item's fields say: its reason, and since when. */
export const BLOCKED_FIELD_ROLES = ["reason", "since"] as const;
export type BlockedFieldRole = (typeof BLOCKED_FIELD_ROLES)[number];
export type BlockedFieldNames = Record<BlockedFieldRole, string | null>;

const FIELDS = [
  "site",
  "api_base",
  "issue_type",
  "subtask_type",
  "priorities",
  "resolutions",
  "link_types",
  "field_labels",
  "pool_issue_types",
  "blocked_fields",
];

/** The issue type a new issue gets when none is configured. */
export const DEFAULT_ISSUE_TYPE = "Task";

export const DEFAULT_PRIORITIES: Record<PriorityName, string> = {
  urgent: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const DEFAULT_RESOLUTIONS: Record<ResolvedState, string> = {
  done: "Done",
  canceled: "Won't Do",
  duplicate: "Duplicate",
};

export const DEFAULT_LINK_TYPES: Record<LinkedRelation, string> = {
  blocks: "Blocks",
  related: "Relates",
  duplicate: "Duplicate",
};

const field = (name: string) => `issue_tracker.jira.${name}`;

function sectionOf(raw: unknown): Record<string, unknown> {
  return settingsSection(raw, "jira", FIELDS);
}

const SITE = /^https:\/\/[A-Za-z0-9.-]+\/?$/;

/**
 * Hosts a credential may be sent to: Atlassian Cloud, and any host the
 * environment (trusted, unlike the repository's configuration) names in
 * `JIRA_ALLOWED_HOSTS`, comma separated.
 */
function hostAllowed(host: string, env = process.env): boolean {
  if (host.endsWith(".atlassian.net")) return true;
  return (env.JIRA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .includes(host.toLowerCase());
}

function siteOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const site = nonEmpty(v, field("site"));
  if (!SITE.test(site))
    throw new TrackerConfigError(
      field("site"),
      `${field("site")} must be the site's https address, such as https://example.atlassian.net (got ${JSON.stringify(site)})`,
    );
  if (!hostAllowed(new URL(site).hostname))
    throw new TrackerConfigError(
      field("site"),
      `${field("site")} must be an Atlassian Cloud site (*.atlassian.net); another host receives the credential only when JIRA_ALLOWED_HOSTS names it (got ${JSON.stringify(site)})`,
    );
  return site.replace(/\/$/, "");
}

/**
 * Atlassian's API gateway for one Jira Cloud site: that host, that path and
 * a cloud id (letters, digits and hyphens), nothing else; no port, no
 * user, no query and no further path.
 */
const API_BASE =
  /^https:\/\/api\.atlassian\.com\/ex\/jira\/[A-Za-z0-9][A-Za-z0-9-]{0,63}\/?$/;

function apiBaseOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const base = nonEmpty(v, field("api_base"));
  if (!API_BASE.test(base))
    throw new TrackerConfigError(
      field("api_base"),
      `${field("api_base")} must be Atlassian's API gateway address for the site, https://api.atlassian.com/ex/jira/<cloud id>, and nothing else (got ${JSON.stringify(base)})`,
    );
  return base.replace(/\/$/, "");
}

/**
 * A mapping of `keys` to a name or a list of names, over `defaults`. Every
 * name in every list must differ from the others, ignoring case, since a
 * name given twice would read back as two keys.
 */
function namesOf<K extends string>(
  v: unknown,
  name: string,
  keys: ReadonlyArray<K>,
  defaults: Record<K, string>,
  what: string,
): Record<K, string[]> {
  const out = Object.fromEntries(keys.map((k) => [k, [defaults[k]]])) as Record<
    K,
    string[]
  >;
  if (v !== undefined && v !== null && !isRecord(v))
    throw new TrackerConfigError(
      field(name),
      `${field(name)} must be a mapping`,
    );
  for (const [key, value] of Object.entries(v ?? {})) {
    const at = `${field(name)}.${key}`;
    if (!(keys as readonly string[]).includes(key))
      throw new TrackerConfigError(
        at,
        `${at} is not one of ${keys.join(", ")}`,
      );
    out[key as K] = nameList(value, at, what);
  }
  refuseSharedNames(
    field(name),
    keys.map((k) => [k, out[k]] as const),
    what,
    new Set(Object.keys(v ?? {})),
  );
  return out;
}

/** The relations whose links have a direction, which `inverted` turns round. */
const DIRECTED: ReadonlyArray<LinkedRelation> = ["blocks", "duplicate"];

/** One entry of a relation's list: a name, or `{ name, inverted }`. */
function linkEntryOf(
  v: unknown,
  at: string,
  relation: LinkedRelation,
): LinkTypeEntry {
  if (typeof v === "string")
    return { name: nonEmpty(v, at).trim(), inverted: false };
  if (!isRecord(v))
    throw new TrackerConfigError(
      at,
      `${at} must be a link type's name or { name, inverted }`,
    );
  const extra = Object.keys(v).find((k) => k !== "name" && k !== "inverted");
  if (extra !== undefined)
    throw new TrackerConfigError(
      `${at}.${extra}`,
      `${at}.${extra} is not one of name, inverted`,
    );
  if (v.inverted !== undefined && typeof v.inverted !== "boolean")
    throw new TrackerConfigError(
      `${at}.inverted`,
      `${at}.inverted must be true or false`,
    );
  const inverted = v.inverted === true;
  if (inverted && !DIRECTED.includes(relation))
    throw new TrackerConfigError(
      `${at}.inverted`,
      `${at}.inverted: ${relation} has no direction to invert`,
    );
  return { name: nonEmpty(v.name, `${at}.name`).trim(), inverted };
}

/**
 * `link_types`: each relation to one link type or a list of them. Every name
 * in every list must differ from the others, ignoring case, since a link of a
 * type named twice would read as two relations.
 */
function linkTypesOf(v: unknown): Record<LinkedRelation, LinkTypeEntry[]> {
  const at = field("link_types");
  if (v !== undefined && v !== null && !isRecord(v))
    throw new TrackerConfigError(at, `${at} must be a mapping`);
  const out = Object.fromEntries(
    LINKED_RELATIONS.map((r) => [
      r,
      [{ name: DEFAULT_LINK_TYPES[r], inverted: false }],
    ]),
  ) as Record<LinkedRelation, LinkTypeEntry[]>;
  for (const [key, value] of Object.entries(v ?? {})) {
    const where = `${at}.${key}`;
    if (!(LINKED_RELATIONS as readonly string[]).includes(key))
      throw new TrackerConfigError(
        where,
        `${where} is not one of ${LINKED_RELATIONS.join(", ")}`,
      );
    const relation = key as LinkedRelation;
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0)
      throw new TrackerConfigError(where, `${where} names no link type`);
    out[relation] = list.map((e, i) =>
      linkEntryOf(e, Array.isArray(value) ? `${where}[${i}]` : where, relation),
    );
  }
  const names = LINKED_RELATIONS.flatMap((r) => out[r].map((e) => e.name));
  const twice = firstRepeat(names);
  if (twice !== undefined)
    throw new TrackerConfigError(
      at,
      `${at} names '${twice}' twice; each needs its own name`,
    );
  return out;
}

/**
 * `pool_issue_types`: the issue types every pool is limited to. Whether the
 * project has each is checked when the site is first read.
 */
function poolIssueTypesOf(v: unknown): string[] {
  const at = field("pool_issue_types");
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length === 0)
    throw new TrackerConfigError(
      at,
      `${at} must be a non-empty list of issue type names; leave it out to pool every type`,
    );
  const out: string[] = [];
  for (const [i, t] of v.entries()) {
    const name = nonEmpty(t, `${at}[${i}]`).trim();
    if (out.some((o) => o.toLowerCase() === name.toLowerCase()))
      throw new TrackerConfigError(at, `${at} names '${name}' twice`);
    out.push(name);
  }
  return out;
}

/** A label prefix: no whitespace, since a Jira label holds none. */
const PREFIX = /^\S{1,100}$/;

/**
 * `field_labels`: each field, by name or id, to the prefix its values carry
 * as labels. A field named twice, or a prefix that begins another, would
 * make a label's field ambiguous, so either is refused.
 */
function fieldLabelsOf(v: unknown): Record<string, string> {
  const at = field("field_labels");
  if (v === undefined || v === null) return {};
  if (!isRecord(v))
    throw new TrackerConfigError(
      at,
      `${at} must be a mapping from a field's name or id to a label prefix`,
    );
  const out: Record<string, string> = {};
  for (const [name, prefix] of Object.entries(v)) {
    const key = name.trim();
    const where = `${at}.${key}`;
    if (key === "")
      throw new TrackerConfigError(at, `${at} names an empty field`);
    if (Object.keys(out).some((k) => k.toLowerCase() === key.toLowerCase()))
      throw new TrackerConfigError(where, `${at} names '${key}' twice`);
    if (typeof prefix !== "string" || !PREFIX.test(prefix))
      throw new TrackerConfigError(
        where,
        `${where} must be a label prefix without whitespace, such as "size:"`,
      );
    const clash = Object.entries(out).find(
      ([, p]) =>
        p.toLowerCase().startsWith(prefix.toLowerCase()) ||
        prefix.toLowerCase().startsWith(p.toLowerCase()),
    );
    if (clash !== undefined)
      throw new TrackerConfigError(
        where,
        `${where} is '${prefix}', which overlaps '${clash[1]}' (${at}.${clash[0]}); a label would belong to both`,
      );
    out[key] = prefix;
  }
  return out;
}

/**
 * `blocked_fields`: the field each role is written to when the drive-ledger
 * projection moves an item to `blocked`, by name or id; a role left out is
 * not written. Both naming one field is refused.
 */
function blockedFieldsOf(v: unknown): BlockedFieldNames {
  const at = field("blocked_fields");
  const out: BlockedFieldNames = { reason: null, since: null };
  if (v === undefined || v === null) return out;
  if (!isRecord(v))
    throw new TrackerConfigError(
      at,
      `${at} must be a mapping of reason and since to a field's name or id`,
    );
  for (const [key, value] of Object.entries(v)) {
    const where = `${at}.${key}`;
    if (!(BLOCKED_FIELD_ROLES as readonly string[]).includes(key))
      throw new TrackerConfigError(
        where,
        `${where} is not one of ${BLOCKED_FIELD_ROLES.join(", ")}`,
      );
    out[key as BlockedFieldRole] = nonEmpty(value, where).trim();
  }
  if (
    out.reason !== null &&
    out.since !== null &&
    out.reason.toLowerCase() === out.since.toLowerCase()
  )
    throw new TrackerConfigError(
      at,
      `${at} names '${out.reason}' for both reason and since; each needs its own field`,
    );
  return out;
}

/** Validate `issue_tracker.jira`. */
export function parseJiraSettings(raw: unknown): JiraSettings {
  const section = sectionOf(raw);
  return {
    site: siteOf(section.site),
    apiBase: apiBaseOf(section.api_base),
    issueType:
      section.issue_type === undefined || section.issue_type === null
        ? DEFAULT_ISSUE_TYPE
        : nonEmpty(section.issue_type, field("issue_type")),
    subtaskType:
      section.subtask_type === undefined || section.subtask_type === null
        ? null
        : nonEmpty(section.subtask_type, field("subtask_type")),
    priorities: namesOf(
      section.priorities,
      "priorities",
      PRIORITY_NAMES,
      DEFAULT_PRIORITIES,
      "priority",
    ),
    resolutions: namesOf(
      section.resolutions,
      "resolutions",
      RESOLVED_STATES,
      DEFAULT_RESOLUTIONS,
      "resolution",
    ),
    linkTypes: linkTypesOf(section.link_types),
    fieldLabels: fieldLabelsOf(section.field_labels),
    poolIssueTypes: poolIssueTypesOf(section.pool_issue_types),
    blockedFields: blockedFieldsOf(section.blocked_fields),
  };
}

/** The site; throws naming the field when it is not set. */
export function requireSite(settings: JiraSettings): string {
  if (settings.site === null)
    throw new TrackerConfigError(
      field("site"),
      `${field("site")} is not set; it names the Jira Cloud site, such as https://example.atlassian.net`,
    );
  return settings.site;
}

/** Where requests go: the API gateway when `api_base` is set, else the site. */
export function requestBase(settings: JiraSettings): string {
  return settings.apiBase ?? requireSite(settings);
}
