/**
 * What the Window panel and the log show, as pure functions of `GET /rows`.
 */
import type {
  LineSnapshot,
  RecurringClass,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type {
  EndedRow,
  EventRow,
  LogRow,
} from "../../plugin/dispatch/lib/log.ts";
import { lengthOf, plural, stamp } from "./format.ts";
import type { LogFilter } from "./search.ts";
import { eventRole, ROLES, type Role, roleOf, stageMark } from "./status.ts";
import type { EvidenceRow } from "./view.ts";

/** What a row's times are read against. */
export interface RowClock {
  /** The host's day now, from `hostDay`. */
  today: string;
  timeZone: string;
}

/** The forge address a pull request's link starts with, per repository. */
export type Forges = Map<string, string>;

const PULL_URL = /^(.*\/)([^/]+\/[^/]+)\/pull\/\d+$/;

/**
 * Where each repository's pull requests live, from the links the line holds: a
 * log row carries no link of its own. A repository no link names takes the one
 * forge the line shows, when it shows exactly one.
 */
export function forgesOf(line: LineSnapshot | null): Forges {
  const forges: Forges = new Map();
  if (line === null) return forges;
  const urls = [...line.sessions, ...line.needs, ...line.queue].map(
    (x) => x.url,
  );
  for (const url of urls) {
    const found = url === null ? null : PULL_URL.exec(url);
    if (found?.[1] !== undefined && found[2] !== undefined)
      forges.set(found[2], found[1]);
  }
  return forges;
}

function pullLink(repo: string, pr: string, forges: Forges): string | null {
  const known = forges.get(repo);
  if (known !== undefined) return `${known}${repo}/pull/${pr}`;
  const bases = new Set(forges.values());
  const [only] = bases;
  return bases.size === 1 && only !== undefined
    ? `${only}${repo}/pull/${pr}`
    : null;
}

export interface RowView {
  key: string;
  time: string;
  label: string;
  role: Role;
  target: string;
  repo: string;
  stage: string;
  mark: string;
  account: string;
  length: string;
  reason: string;
  evidence: EvidenceRow[];
  url: string | null;
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
  const url = pr === null ? null : pullLink(r.repo, pr, forges);
  const numbers = r.kind === "ended" ? endedNumbers(r) : eventNumbers(r);
  return {
    key: r.key,
    time: stamp(Date.parse(r.at), clockNow.today, clockNow.timeZone),
    ...classOfRow(r),
    target: r.target,
    repo: r.repo,
    stage: r.stage,
    mark: stageMark(r.stage),
    account: r.account ?? "",
    length: numbers.length.join(", "),
    reason: r.reason,
    evidence:
      url === null
        ? numbers.evidence
        : [...numbers.evidence, { k: "link", v: url, copy: url }],
    url,
    noLink:
      pr === null
        ? "No tracker link: this repository has no tracker base."
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
