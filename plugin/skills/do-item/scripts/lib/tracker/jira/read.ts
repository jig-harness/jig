/**
 * The fields the Jira adapter reads off an issue, and the strict parse of
 * each into the adapter's own record. A value of the wrong shape throws.
 * Timestamps are read in Jira's `+0000` form and given on as ISO 8601 in
 * UTC.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import { adfToMarkdown } from "./adf.ts";
import type { JiraStatus } from "./model.ts";
import { JiraApiError } from "./transport.ts";

// ── Shape helpers ──────────────────────────────────────────────────────────

export function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new JiraApiError(`${where}: expected an object`);
  return v;
}

export function str(v: unknown, where: string): string {
  if (typeof v !== "string")
    throw new JiraApiError(`${where}: expected a string`);
  return v;
}

export function optStr(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : str(v, where);
}

/** A Jira timestamp (`2026-10-31T12:34:56.000+0000`) as ISO 8601 in UTC. */
export function iso(v: unknown, where: string): string {
  const s = str(v, where).replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new JiraApiError(`${where}: not a timestamp`);
  return new Date(ms).toISOString();
}

function optIso(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : iso(v, where);
}

// ── Issues ─────────────────────────────────────────────────────────────────

/** The fields every read of an issue asks for. */
export const FIELDS = [
  "summary",
  "description",
  "status",
  "resolution",
  "resolutiondate",
  "statuscategorychangedate",
  "priority",
  "labels",
  "issuetype",
  "parent",
  "subtasks",
  "assignee",
  "fixVersions",
  "issuelinks",
  "created",
  "updated",
] as const;

export interface JiraUser {
  accountId: string;
  displayName: string;
}

/** One issue link, seen from the issue that carries it. */
export interface JiraLink {
  type: string;
  /** `outward`: this issue is the link's outward side (it blocks the other). */
  direction: "outward" | "inward";
  issue: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  url: string;
  title: string;
  description: string;
  status: JiraStatus;
  resolution: string | null;
  resolutionDate: string | null;
  categoryChangedAt: string | null;
  priority: string | null;
  labels: string[];
  issueType: { name: string; subtask: boolean; level: number } | null;
  parent: { key: string; title: string } | null;
  assignee: JiraUser | null;
  fixVersions: string[];
  links: JiraLink[];
  createdAt: string;
  updatedAt: string;
}

const STATUS_CATEGORIES = ["new", "indeterminate", "done"];

export function statusOf(v: unknown, where: string): JiraStatus {
  const s = record(v, where);
  const category = isRecord(s.statusCategory) ? s.statusCategory.key : null;
  if (typeof category !== "string" || !STATUS_CATEGORIES.includes(category))
    throw new JiraApiError(
      `${where}.statusCategory.key: expected one of ${STATUS_CATEGORIES.join(", ")} (got ${JSON.stringify(category)})`,
    );
  return {
    id: String(s.id ?? ""),
    name: str(s.name, `${where}.name`),
    category,
  };
}

export function userOf(v: unknown, where: string): JiraUser | null {
  if (v === null || v === undefined) return null;
  const u = record(v, where);
  return {
    accountId: str(u.accountId, `${where}.accountId`),
    displayName: optStr(u.displayName, `${where}.displayName`) ?? "",
  };
}

function linksOf(v: unknown, where: string): JiraLink[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new JiraApiError(`${where}: expected a list`);
  return v.map((l, i) => {
    const link = record(l, `${where}[${i}]`);
    const type = str(
      record(link.type, `${where}[${i}].type`).name,
      "type.name",
    );
    const other = link.outwardIssue ?? link.inwardIssue;
    return {
      type,
      direction: link.outwardIssue === undefined ? "inward" : "outward",
      issue: str(record(other, `${where}[${i}] issue`).key, "link issue key"),
    };
  });
}

function issueTypeOf(v: unknown): JiraIssue["issueType"] {
  if (!isRecord(v) || typeof v.name !== "string") return null;
  return {
    name: v.name,
    subtask: v.subtask === true,
    level:
      typeof v.hierarchyLevel === "number"
        ? v.hierarchyLevel
        : v.subtask === true
          ? -1
          : 0,
  };
}

function labelsOf(v: unknown, where: string): string[] {
  const labels = v ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string"))
    throw new JiraApiError(`${where}: expected a list of names`);
  return labels as string[];
}

function parentOf(v: unknown, where: string): JiraIssue["parent"] {
  if (!isRecord(v)) return null;
  const summary = isRecord(v.fields) ? v.fields.summary : undefined;
  return {
    key: str(v.key, `${where}.key`),
    title: typeof summary === "string" ? summary : "",
  };
}

function versionsOf(v: unknown, where: string): string[] {
  const versions = v ?? [];
  if (!Array.isArray(versions))
    throw new JiraApiError(`${where}: expected a list`);
  return versions.map((x, i) =>
    str(record(x, `${where}[${i}]`).name, `${where}[${i}].name`),
  );
}

/** A field whose values read as labels (`field_labels`), resolved against the site. */
export interface FieldLabel {
  /** The field as `issue_tracker.jira.field_labels` names it. */
  configured: string;
  id: string;
  name: string;
  /** The field in JQL: `cf[10050]` for a custom field, else its id. */
  clause: string;
  prefix: string;
  /**
   * How JQL matches one value exactly: a quoted string (an option, a
   * labels field), a number, or not at all (a text field, which JQL
   * matches by words).
   */
  match: "string" | "number" | null;
}

/**
 * The values of a field read as labels: strings, numbers and options, or a
 * list of them. Each is trimmed, since a label holds no whitespace; an
 * option whose value carries a space is still selected by its exact value
 * in JQL, so a query by the trimmed label misses it.
 */
function fieldValues(v: unknown, where: string): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v))
    return v.flatMap((x, i) => fieldValues(x, `${where}[${i}]`));
  if (typeof v === "number") return [String(v)];
  const text = isRecord(v) ? v.value : v;
  if (typeof text === "string") return text.trim() === "" ? [] : [text.trim()];
  throw new JiraApiError(
    `${where}: expected a string, a number or an option, as issue_tracker.jira.field_labels reads`,
  );
}

/** The labels `fields` give an issue: each value behind its field's prefix. */
function fieldLabelsOf(
  f: Record<string, unknown>,
  fields: ReadonlyArray<FieldLabel>,
  at: (field: string) => string,
): string[] {
  return fields.flatMap((fl) =>
    fieldValues(f[fl.id], at(fl.id)).map((v) => `${fl.prefix}${v}`),
  );
}

/** The `name` of a named field (a priority, a resolution); `null` when unset. */
function nameOf(v: unknown, where: string): string | null {
  return isRecord(v) ? str(v.name, `${where}.name`) : null;
}

/**
 * A search result or an issue read as the adapter's record; the values of
 * `fieldLabels` join its labels.
 */
export function parseIssue(
  v: unknown,
  site: string,
  fieldLabels: ReadonlyArray<FieldLabel> = [],
): JiraIssue {
  const raw = record(v, "issue");
  const key = str(raw.key, "issue.key");
  const at = (field: string) => `issue ${key}.${field}`;
  const f = record(raw.fields, at("fields"));
  return {
    id: String(raw.id ?? ""),
    key,
    url: `${site}/browse/${key}`,
    title: optStr(f.summary, at("summary")) ?? "",
    description: adfToMarkdown(f.description),
    status: statusOf(f.status, at("status")),
    resolution: nameOf(f.resolution, at("resolution")),
    resolutionDate: optIso(f.resolutiondate, at("resolutiondate")),
    categoryChangedAt: optIso(
      f.statuscategorychangedate,
      at("statuscategorychangedate"),
    ),
    priority: nameOf(f.priority, at("priority")),
    labels: [
      ...new Set([
        ...labelsOf(f.labels, at("labels")),
        ...fieldLabelsOf(f, fieldLabels, at),
      ]),
    ],
    issueType: issueTypeOf(f.issuetype),
    parent: parentOf(f.parent, at("parent")),
    assignee: userOf(f.assignee, at("assignee")),
    fixVersions: versionsOf(f.fixVersions, at("fixVersions")),
    links: linksOf(f.issuelinks, at("issuelinks")),
    createdAt: iso(f.created, at("created")),
    updatedAt: iso(f.updated, at("updated")),
  };
}
