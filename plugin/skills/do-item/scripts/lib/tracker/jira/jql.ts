/**
 * JQL (Jira Query Language) for the Jira adapter's listings. Every query
 * starts with `project = <KEY>`, since Jira refuses an unbounded search, and
 * is ordered by creation, so a read pages through a stable order.
 *
 * Strings are double-quoted with `"` and `\` escaped; issue keys in
 * `in (...)` lists go unquoted, after a check that each is a key. Dates have
 * minute precision in the time zone of the credential's Jira profile, so a
 * window is widened by a minute on each side here and filtered exactly by
 * the adapter.
 *
 * A label behind a `field_labels` prefix is a field's value, not a Jira
 * label, so a query for it is a clause on that field.
 */

import { TrackerRequestError } from "../port.ts";
import type { FieldLabel } from "./read.ts";

/** A JQL string literal. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** Keys for an `in (...)` list, unquoted; anything else is refused. */
export function keyList(keys: ReadonlyArray<string>): string {
  for (const k of keys)
    if (!KEY.test(k))
      throw new TrackerRequestError("invalid", `not a Jira issue key: ${k}`);
  return `(${keys.join(", ")})`;
}

/** Strings for an `in (...)` list, each quoted. */
export function stringList(values: ReadonlyArray<string>): string {
  return `(${values.map(quote).join(", ")})`;
}

export const ORDER = " ORDER BY created ASC";

/** `project = KEY AND <clauses>`, ordered by creation; the key is a team key, safe unquoted. */
export function inProject(project: string, ...clauses: string[]): string {
  return `${[`project = ${project}`, ...clauses].join(" AND ")}${ORDER}`;
}

/**
 * The JQL for an open issue: one whose status is not in the Done category,
 * or is the configured blocked status, which the model reads as open whatever
 * category the site files it under.
 */
export function openClause(
  blocked: string | null | undefined | string[],
): string {
  return statusClause("statusCategory != Done", blocked);
}

/** Add the workflow's blocked names to a status-category predicate. */
function statusClause(
  category: string,
  blocked: string | null | undefined | string[],
): string {
  const names = Array.isArray(blocked)
    ? blocked
    : blocked == null
      ? []
      : [blocked];
  if (names.length === 0) return category;
  const clause =
    names.length === 1
      ? `status = ${quote(names[0] as string)}`
      : `status in ${stringList(names)}`;
  return `(${category} OR ${clause})`;
}

/**
 * The JQL for a started issue: one in the In Progress category, or the
 * configured blocked status, which the model reads as started whatever
 * category the site files it under.
 */
export function startedClause(
  blocked: string | null | undefined | string[],
): string {
  return statusClause('statusCategory = "In Progress"', blocked);
}

/**
 * `ms` as a JQL date, `yyyy-MM-dd HH:mm`, in `timeZone` (an IANA name, as
 * Jira's profile gives it).
 */
export function jqlDate(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const MINUTE = 60_000;

/**
 * Padding on each bound: local wall times of two instants either side of a
 * daylight-saving rollback can invert, so the window is made wider than any
 * offset change.
 */
const PAD = 2 * 60 * MINUTE;

/**
 * `field >= since - 1m AND field < until + 1m` in `timeZone`: wide enough
 * for every issue in the window whatever the rounding; the caller filters
 * each by its exact time.
 */
export function widened(
  field: string,
  window: { sinceMs: number; untilMs: number },
  timeZone: string,
): string {
  return `${field} >= ${quote(jqlDate(window.sinceMs - PAD, timeZone))} AND ${field} < ${quote(jqlDate(window.untilMs + PAD, timeZone))}`;
}

/** `field >= since - 1m` in `timeZone`. */
export function since(
  field: string,
  sinceMs: number,
  timeZone: string,
): string {
  return `${field} >= ${quote(jqlDate(sinceMs - PAD, timeZone))}`;
}

/** The field a label is a value of, by its prefix; `null` for a Jira label. */
export function fieldOfLabel(
  label: string,
  fields: ReadonlyArray<FieldLabel>,
): { field: FieldLabel; value: string } | null {
  const field = fields.find((f) => label.startsWith(f.prefix));
  return field === undefined
    ? null
    : { field, value: label.slice(field.prefix.length) };
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** A value of `field` as a JQL literal, or a refusal where JQL cannot match it exactly. */
function jqlValue(field: FieldLabel, value: string, label: string): string {
  if (field.match === "string") return quote(value);
  if (field.match === "number" && NUMBER.test(value)) return value;
  throw new TrackerRequestError(
    "invalid",
    field.match === "number"
      ? `label '${label}' names the number field '${field.name}' with '${value}', which is not a number`
      : `label '${label}' is read from the text field '${field.name}' (issue_tracker.jira.field_labels), which JQL matches by words, not exactly; an issue cannot be selected by it`,
  );
}

/** `labels` split into Jira labels and, per field, the values they name. */
function split(
  labels: ReadonlyArray<string>,
  fields: ReadonlyArray<FieldLabel>,
): { plain: string[]; byField: Map<FieldLabel, string[]> } {
  const plain: string[] = [];
  const byField = new Map<FieldLabel, string[]>();
  for (const label of labels) {
    const found = fieldOfLabel(label, fields);
    if (found === null) plain.push(label);
    else
      byField.set(found.field, [
        ...(byField.get(found.field) ?? []),
        jqlValue(found.field, found.value, label),
      ]);
  }
  return { plain, byField };
}

/** The issues carrying `label`. */
export function hasLabel(
  label: string,
  fields: ReadonlyArray<FieldLabel> = [],
): string {
  const found = fieldOfLabel(label, fields);
  return found === null
    ? `labels = ${quote(label)}`
    : `${found.field.clause} = ${jqlValue(found.field, found.value, label)}`;
}

/** The issues carrying at least one of `labels`. */
export function someLabel(
  labels: ReadonlyArray<string>,
  fields: ReadonlyArray<FieldLabel> = [],
): string {
  const { plain, byField } = split(labels, fields);
  const clauses = [
    ...(plain.length === 0 ? [] : [`labels in ${stringList(plain)}`]),
    ...[...byField].map(([f, v]) => `${f.clause} in (${v.join(", ")})`),
  ];
  return clauses.length === 1
    ? (clauses[0] as string)
    : `(${clauses.join(" OR ")})`;
}

/**
 * The issues carrying none of `labels`. `labels not in (...)` alone drops
 * every issue with no labels at all, hence the `is EMPTY` clause; a field
 * read as labels takes the same form.
 */
export function noLabel(
  labels: ReadonlyArray<string>,
  fields: ReadonlyArray<FieldLabel> = [],
): string {
  const { plain, byField } = split(labels, fields);
  return [
    ...(plain.length === 0
      ? []
      : [`(labels not in ${stringList(plain)} OR labels is EMPTY)`]),
    ...[...byField].map(
      ([f, v]) =>
        `(${f.clause} not in (${v.join(", ")}) OR ${f.clause} is EMPTY)`,
    ),
  ].join(" AND ");
}
