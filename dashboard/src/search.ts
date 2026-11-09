/**
 * The page's one query string: which view it shows and which window and filters
 * the log shows, beside the `token` and `theme` it was opened with, so a phone's
 * view is a link a laptop can open. A change replaces the address; it adds no
 * history entry.
 */
import { useCallback, useRef, useState } from "react";
import { instantOf } from "./format.ts";

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
] as const;

export type Preset = (typeof PRESETS)[number]["id"];

/**
 * The page's views, one per question, each with the key that goes to it after
 * `g`: what is safe to merge, what needs a person, what is running, what is
 * coming, how it went, and how to read the page.
 */
export const VIEWS = [
  { id: "merge", label: "Merge", key: "m" },
  { id: "needs", label: "Needs you", key: "n" },
  { id: "running", label: "Running", key: "r" },
  { id: "queue", label: "Queue", key: "q" },
  { id: "history", label: "History", key: "h" },
  { id: "help", label: "Help", key: null },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

/** The views whose cards the view's own filter narrows; History's log has its own filters. */
export const FILTERED_VIEWS: ReadonlySet<ViewId> = new Set([
  "merge",
  "needs",
  "running",
  "queue",
]);

/** The view an address from before the five views names: Now became Needs you. */
const RENAMED: ReadonlyMap<string, ViewId> = new Map([["now", "needs"]]);

/** A named window, or `range` when `from` or `to` names one. */
export type WindowChoice = Preset | "range";

export interface LogFilter {
  window: WindowChoice;
  /** As a `datetime-local` control gives it: a time on the host's clock. */
  from: string;
  to: string;
  repo: string;
  stage: string;
  account: string;
  class: string;
  reason: string;
}

const TEXT_FIELDS = ["repo", "stage", "account", "class", "reason"] as const;

function presetOf(value: string | null): Preset {
  return PRESETS.find((p) => p.id === value)?.id ?? "today";
}

/** The filter a query string names; what it leaves out filters nothing. */
export function readFilter(search: string): LogFilter {
  const params = new URLSearchParams(search);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  return {
    window: from !== "" || to !== "" ? "range" : presetOf(params.get("window")),
    from,
    to,
    repo: params.get("repo") ?? "",
    stage: params.get("stage") ?? "",
    account: params.get("account") ?? "",
    class: params.get("class") ?? "",
    reason: params.get("reason") ?? "",
  };
}

/** A filter with a change applied: picking a preset ends a range, and a range ends a preset. */
export function applyPatch(
  filter: LogFilter,
  patch: Partial<LogFilter>,
): LogFilter {
  const next = { ...filter, ...patch };
  if (patch.window !== undefined && patch.window !== "range")
    return { ...next, from: "", to: "" };
  if (patch.from !== undefined || patch.to !== undefined)
    return { ...next, window: "range" };
  return next;
}

/** Each value as it reads in the address: a space as `+`, slashes and colons left as they are. */
function encoded(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
}

function filterPairs(filter: LogFilter): Array<[string, string]> {
  const when: Array<[string, string]> =
    filter.window === "range"
      ? [
          ["from", filter.from],
          ["to", filter.to],
        ]
      : [["window", filter.window]];
  const fields = TEXT_FIELDS.map((name): [string, string] => [
    name,
    filter[name],
  ]);
  return [...when, ...fields].filter(([, value]) => value !== "");
}

function queryOf(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}=${encoded(v)}`).join("&");
}

/** The filter's part of the address, as the page shows it: `?window=7d&repo=example-org/web`. */
export function viewQuery(filter: LogFilter): string {
  return `?${queryOf(filterPairs(filter))}`;
}

/**
 * The filter as `GET /rows` asks for it: a range's times become instants in the
 * host's zone, which the server may not be running in. A time that already
 * names its offset goes as it is.
 */
export function rowsQuery(filter: LogFilter, timeZone: string | null): string {
  const pairs = filterPairs(filter).map(([name, value]): [string, string] => {
    if ((name !== "from" && name !== "to") || timeZone === null)
      return [name, value];
    return [name, instantOf(value, timeZone) ?? value];
  });
  return queryOf(pairs);
}

/** The whole query string: what the page was opened with, then the filter. */
export function pageQuery(filter: LogFilter, search: string): string {
  const params = new URLSearchParams(search);
  const kept = ["token", "theme", "view"].flatMap(
    (name): Array<[string, string]> => {
      const value = params.get(name);
      return value === null ? [] : [[name, value]];
    },
  );
  return `?${queryOf([...kept, ...filterPairs(filter)])}`;
}

/** The token the page was opened with. */
export function tokenOf(search: string): string {
  return new URLSearchParams(search).get("token") ?? "";
}

/** The view the address names; `null` when it names none, and the page picks one from the line. */
export function viewOf(search: string): ViewId | null {
  const named = new URLSearchParams(search).get("view");
  if (named === null) return null;
  return VIEWS.find((v) => v.id === named)?.id ?? RENAMED.get(named) ?? null;
}

/** The view a page opens on when its address names none: Merge while merge now holds anything, else Needs you. */
export function openingView(mergeNow: number): ViewId {
  return mergeNow > 0 ? "merge" : "needs";
}

/**
 * The query string with one parameter set, or left out when `value` is `null`;
 * every other pair stays as it was written.
 */
export function withParam(
  search: string,
  name: string,
  value: string | null,
): string {
  const pairs = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "" && !new URLSearchParams(pair).has(name));
  if (value !== null) pairs.push(`${name}=${encoded(value)}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** Sets one parameter of the address in place, adding no history entry. */
export function replaceParam(name: string, value: string | null): void {
  history.replaceState(
    null,
    "",
    `${location.pathname}${withParam(location.search, name, value)}`,
  );
}

/**
 * The view in the address, and how to change it. An address that names none
 * opens on the view `opening` gives once the first line is read, and stays
 * there as later reads arrive: a page never moves under a person.
 */
export function useView(
  opening: ViewId | null,
): [ViewId, (view: ViewId) => void] {
  const [named, setNamed] = useState(() => viewOf(location.search));
  const [settled, setSettled] = useState<ViewId | null>(null);
  if (named === null && settled === null && opening !== null)
    setSettled(opening);
  const change = useCallback((next: ViewId) => {
    setNamed(next);
    replaceParam("view", next);
    window.scrollTo({ top: 0 });
  }, []);
  return [named ?? settled ?? "needs", change];
}

/** The filter in the address, and how to change it. */
export function useFilter(): [LogFilter, (patch: Partial<LogFilter>) => void] {
  const [filter, setFilter] = useState(() => readFilter(location.search));
  const latest = useRef(filter);
  const patch = useCallback((change: Partial<LogFilter>) => {
    const next = applyPatch(latest.current, change);
    latest.current = next;
    setFilter(next);
    history.replaceState(
      null,
      "",
      `${location.pathname}${pageQuery(next, location.search)}`,
    );
  }, []);
  return [filter, patch];
}
