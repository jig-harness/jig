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
 */

import { TrackerRequestError } from "../port.ts";

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

/** The JQL for an open issue: one whose status is not in the Done category. */
export const OPEN = "statusCategory != Done";

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

/** The issues carrying at least one of `labels`. */
export function someLabel(labels: ReadonlyArray<string>): string {
  return `labels in ${stringList(labels)}`;
}

/**
 * The issues carrying none of `labels`. `labels not in (...)` alone drops
 * every issue with no labels at all, hence the `is EMPTY` clause.
 */
export function noLabel(labels: ReadonlyArray<string>): string {
  return `(labels not in ${stringList(labels)} OR labels is EMPTY)`;
}
