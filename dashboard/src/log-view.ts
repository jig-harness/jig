/**
 * What the Window panel and the log show, as pure functions of `GET /rows`.
 */
import type {
  RecurringClass,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type {
  EndedRow,
  EventRow,
  LogRow,
} from "../../plugin/dispatch/lib/log.ts";
import { lengthOf, plural, stamp } from "./format.ts";
import { derivedLink, type Forges, noLinkText } from "./links.ts";
import type { LogFilter } from "./search.ts";
import { eventRole, ROLES, type Role, roleOf } from "./status.ts";
import type { EvidenceRow } from "./view.ts";

/** What a row's times are read against. */
export interface RowClock {
  /** The host's day now, from `hostDay`. */
  today: string;
  timeZone: string;
}

export interface RowView {
  key: string;
  time: string;
  label: string;
  role: Role;
  target: string;
  /** The target's title: the row's own, else the one the line holds for it. */
  title: string | null;
  repo: string;
  stage: string;
  account: string;
  length: string;
  reason: string;
  evidence: EvidenceRow[];
  url: string | null;
  /** What its link says: the pull request or the item. */
  goLabel: string;
  noLink: string | null;
}

/** A row's class by its own name, with its role; an observation no class names reads as its event. */
function classOfRow(r: LogRow): { label: string; role: Role } {
  if (r.class !== null)
    return { label: r.class, role: roleOf("outcome class", r.class) };
  return r.kind === "event"
    ? { label: `event: ${r.event}`, role: eventRole(r.event) }
    : { label: "unknown", role: ROLES.unknown };
}

/** What a row's numbers say: its length cell's parts and the evidence that states them. */
interface RowNumbers {
  length: string[];
  evidence: EvidenceRow[];
}

/** An ended row's duration, a drive's rounds, and its launch record. */
function endedNumbers(r: EndedRow): RowNumbers {
  const numbers: RowNumbers = { length: [], evidence: [] };
  const duration = r.durationMs ?? null;
  if (duration !== null) {
    numbers.length.push(lengthOf(duration));
    numbers.evidence.push({ k: "duration", v: lengthOf(duration) });
  }
  if (r.rounds !== null) {
    numbers.length.push(plural(r.rounds, "round"));
    numbers.evidence.push({ k: "rounds", v: String(r.rounds) });
  }
  numbers.evidence.push({ k: "record", v: r.record, copy: r.record });
  return numbers;
}

/** What an observation saw, and how long a hold waited. */
function eventNumbers(r: EventRow): RowNumbers {
  const duration = r.durationMs ?? null;
  return {
    length: duration === null ? [] : [`waited ${lengthOf(duration)}`],
    evidence: [{ k: "event", v: r.event }],
  };
}

/** One row of the log, as its cells and its opened body show it. */
export function rowView(
  r: LogRow,
  clockNow: RowClock,
  forges: Forges,
): RowView {
  const pr = /^PR #(\d+)$/.exec(r.target)?.[1] ?? null;
  const url = r.url ?? derivedLink(r.repo, r.target, forges);
  const numbers = r.kind === "ended" ? endedNumbers(r) : eventNumbers(r);
  const title = r.title ?? forges.titles.get(`${r.repo} ${r.target}`) ?? null;
  const evidence = [
    ...(title === null ? [] : [{ k: "title", v: title }]),
    ...numbers.evidence,
    ...(url === null ? [] : [{ k: "link", v: url, copy: url }]),
  ];
  return {
    key: r.key,
    time: stamp(Date.parse(r.at), clockNow.today, clockNow.timeZone),
    ...classOfRow(r),
    target: r.target,
    title,
    repo: r.repo,
    stage: r.stage,
    account: r.account ?? "",
    length: numbers.length.join(", "),
    reason: r.reason,
    evidence,
    url,
    goLabel: pr === null ? `Open ${r.target}` : "Open the pull request",
    // A defect is about a stage, not a target, so it has nothing to link.
    noLink:
      url === null && pr === null && r.target !== ""
        ? noLinkText(r.repo, r.target)
        : null,
  };
}

export interface ClassChip {
  name: string;
  count: number;
  role: Role;
}

/**
 * The class chips, largest first: the counts that name a class. An entry named
 * `event: x` is an observation no class names, so it is no chip. The class being
 * filtered on stays a chip when it counts nothing, so it can be turned off.
 */
export function classChips(answer: RowsAnswer, current: string): ClassChip[] {
  const counts = new Map(
    Object.entries(answer.counts).filter(
      ([name]) => !name.startsWith("event: "),
    ),
  );
  if (current !== "" && !current.startsWith("event: ") && !counts.has(current))
    counts.set(current, 0);
  const order = (name: string) => {
    const at = answer.options.class.indexOf(name);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))
    .map(([name, count]) => ({
      name,
      count,
      role: roleOf("outcome class", name),
    }));
}

/** `5 rows from 00:00 to 16:47`, or how much of a truncated answer is shown. */
export function metaLine(answer: RowsAnswer, clockNow: RowClock): string {
  return answer.truncated
    ? `newest ${answer.rows.length} of ${answer.total} rows: narrow the window or a filter to see the rest`
    : `${plural(answer.total, "row")} from ${windowText(answer, clockNow)}`;
}

/** `00:00 to 16:47`. */
export function windowText(answer: RowsAnswer, clockNow: RowClock): string {
  const { today, timeZone } = clockNow;
  return `${stamp(Date.parse(answer.from), today, timeZone)} to ${stamp(Date.parse(answer.to), today, timeZone)}`;
}

export interface RecurringView {
  rowKey: string;
  cls: string;
  repo: string;
  stage: string;
  /** What its button says: the class, the repository and the stage. */
  title: string;
  /** The log's filter its button sets: its rows over the last seven days. */
  filter: Partial<LogFilter>;
  role: Role;
  nights: boolean[];
  label: string;
  note: string;
  finding: string;
}

/** A class that recurs on one stage of a repository, as its row in the recurring block shows it. */
export function recurringView(r: RecurringClass): RecurringView {
  const nights = r.nights.filter(Boolean).length;
  return {
    rowKey: JSON.stringify([r.class, r.repo, r.stage]),
    cls: r.class,
    repo: r.repo,
    stage: r.stage,
    title: `${r.class} on ${r.repo}, ${r.stage}`,
    filter: { repo: r.repo, stage: r.stage, class: r.class, window: "7d" },
    role: ROLES.badly,
    nights: r.nights,
    label: `${nights} of the last 7 nights`,
    note: `${nights} of 7 nights, ${plural(r.rows, "row")}`,
    finding: `Recurring: ${r.class} on the ${r.stage} stage of ${r.repo}, ${nights} of the last 7 nights, ${plural(r.rows, "row")}`,
  };
}

/** The active filters, each with what clears it. */
export function activeFilters(
  filter: LogFilter,
): Array<{ label: string; clear: Partial<LogFilter> }> {
  const active: Array<{ label: string; clear: Partial<LogFilter> }> = [];
  if (filter.repo !== "")
    active.push({ label: `repository ${filter.repo}`, clear: { repo: "" } });
  if (filter.stage !== "")
    active.push({ label: `stage ${filter.stage}`, clear: { stage: "" } });
  if (filter.account !== "")
    active.push({ label: `account ${filter.account}`, clear: { account: "" } });
  if (filter.class !== "")
    active.push({ label: `class ${filter.class}`, clear: { class: "" } });
  if (filter.reason !== "")
    active.push({
      label: `reason contains “${filter.reason}”`,
      clear: { reason: "" },
    });
  return active;
}

/** The values a filter offers: what the window holds, and what is chosen even when it holds none. */
export function optionsWith(values: string[], current: string): string[] {
  return current === "" || values.includes(current)
    ? values
    : [...values, current].sort((a, b) => a.localeCompare(b));
}
