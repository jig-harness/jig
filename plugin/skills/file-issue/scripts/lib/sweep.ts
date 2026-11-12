/**
 * The weekly sweep (design/tracker-facets.md, "The weekly sweep"): every
 * open issue outside triage and not yet started that lacks a type, a
 * priority or a size (no size asked of an epic), or carries a retired label
 * (a facet's label where the facet is kept elsewhere), read through the
 * tracker interface's `incompleteIssues`, so it works on every adapter.
 *
 * Applied, each such issue is moved back to the `triage` state with a
 * comment naming what it lacks. The comment goes first and carries a marker
 * naming the missing facets and retired labels: a run that stopped between
 * the comment and the move finds the marker next time, moves the issue and
 * posts nothing again. An issue already started is listed, never moved,
 * since moving it would take it from the session working it.
 *
 * With `move: false` (`file_issue.sweep.move`, for a lane where only a
 * person may move a ready issue back), each such issue gets the comment and
 * keeps its state. It then stays in every later listing, so an issue that
 * already carries the marker is passed over before the budget is counted.
 *
 * Its bounds: at most 20 listing pages of 100 incomplete issues and 50
 * issues moved (or, without moving, commented on) a run, the writes paced
 * (`pace.ts`); a refused write stops the run, which reports what it moved
 * and what remains. A store problem moves nothing: a store
 * that fails closed, or more than half of the issues that must carry a facet
 * lacking it by the tracker's own counts. It reports issue keys, never a
 * title or a body.
 */

import type {
  Facet,
  FacetStores,
  IncompleteIssue,
  IncompletePage,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import { failureLine, type Writer, WriteRefused } from "./pace.ts";

export const SWEEP_LIMITS = { pages: 20, pageSize: 100, moves: 50 } as const;

/** The marker a sweep comment carries, as written after `<!--`. */
export const SWEEP_MARKER = "jig:issue-fields";

export interface SweepOptions {
  /** Move and comment; without it the sweep only reports. */
  apply: boolean;
  /** Move each issue back to triage (the default); `false` only comments. */
  move?: boolean;
  /** The labels of each facet the stores keep outside labels. */
  retired: (stores: FacetStores) => string[];
  writer: Writer;
  limits?: Partial<{ pages: number; pageSize: number; moves: number }>;
  /** Told of each issue as it is moved, by key, so a run cut short still shows what it did. */
  progress?: (line: string) => void;
  epic?: string;
}

export interface SweepReport {
  /** Each facet's store, as `facetStores` reported it. */
  stores: Array<{
    facet: Facet;
    store: string | null;
    why: string;
    problem?: string;
  }>;
  /** Why the sweep moves nothing, or `null`. */
  storeProblem: string | null;
  /** Whether the issues were read: a store that fails closed reads none. */
  read: boolean;
  /** The tracker's counts over every open issue outside triage. */
  counts: IncompletePage["counts"];
  /** The incomplete issues not yet started that the read reached. */
  listed: IncompleteIssue[];
  /** The incomplete issues already started: listed, never moved. */
  started: IncompleteIssue[];
  /** More started issues than one page holds. */
  startedMore: boolean;
  /** The read stopped at its page cap with issues left to read. */
  readCapped: boolean;
  /** Moved back to triage by this run. */
  moved: string[];
  /** Changed during pacing and left for a fresh read. */
  skipped: string[];
  /** Commented on by this run (an issue a stopped run commented on is moved without one). */
  commented: string[];
  /** Without moving: already carrying the marker, so passed over outside the budget. */
  marked: string[];
  /** Why a write stopped the run, or `null`. */
  stopped: string | null;
  apply: boolean;
  /** Whether the run moves issues to triage or only comments on them. */
  move: boolean;
}

/** The marker naming what an issue lacks and the retired labels it carries. */
export function sweepMarker(issue: IncompleteIssue): string {
  const missing = issue.missing.length === 0 ? "-" : issue.missing.join(",");
  const retired =
    issue.retired.length === 0
      ? ""
      : ` retired=${issue.retired.map(encodeURIComponent).join(",")}`;
  return `<!-- ${SWEEP_MARKER} missing=${missing}${retired} -->`;
}

/** The comment that moves an issue back to triage, or with `move: false` leaves it, naming why. */
export function sweepComment(issue: IncompleteIssue, move = true): string {
  const lacks =
    issue.missing.length === 0
      ? ""
      : ` It has ${issue.missing.map((f) => `no ${f}`).join(", ")}: give it each one.`;
  const retired =
    issue.retired.length === 0
      ? ""
      : ` It carries labels this repository no longer keeps its type, priority or size in (${issue.retired.map((l) => `\`${l}\``).join(", ")}): set each value in the tracker's own field and remove the label.`;
  return move
    ? `${sweepMarker(issue)}\nThe weekly issue-fields sweep moved this issue back to triage.${lacks}${retired} Then move it on.`
    : `${sweepMarker(issue)}\nThe weekly issue-fields sweep found this issue incomplete and left it where it is.${lacks}${retired}`;
}

/** Why the stores the tracker reported keep the sweep from moving anything, or `null`. */
function storeProblems(stores: FacetStores): string | null {
  const problems: string[] = [];
  for (const f of stores.facets) {
    if (f.problem !== undefined)
      problems.push(`${f.facet}: ${f.problem}`.slice(0, 300));
    else if (f.health?.status === "failed")
      problems.push(`${f.facet}: ${f.health.error}`.slice(0, 300));
    else if (f.detection?.status === "failed")
      problems.push(
        `${f.facet}: detection failed: ${f.detection.error}`.slice(0, 300),
      );
  }
  return problems.length === 0 ? null : problems.join("; ");
}

/** A facet more than half of whose required issues lack it: a store that stopped answering. */
function emptiedStore(counts: IncompletePage["counts"]): string | null {
  for (const [facet, c] of Object.entries(counts))
    if (c !== undefined && c.required > 0 && c.lacking * 2 > c.required)
      return `${facet}: ${c.lacking} of the ${c.required} open issues outside triage that must carry it lack it, more than half, which is a store that stopped answering, not a pile of bad filings; moving none`;
  return null;
}

/** Read every page the caps allow, then the one page of started issues. */
async function readAll(
  tracker: Tracker,
  query: { missing: Facet[]; retired: string[] },
  opts: SweepOptions,
  report: SweepReport,
): Promise<void> {
  const pages = opts.limits?.pages ?? SWEEP_LIMITS.pages;
  const limit = opts.limits?.pageSize ?? SWEEP_LIMITS.pageSize;
  const read = {
    census: {},
    deadline: Date.now() + 60_000,
    ...(opts.writer.signal === undefined ? {} : { signal: opts.writer.signal }),
  };
  let after: string | null = null;
  for (let page = 0; page < pages; page++) {
    const got = await tracker.incompleteIssues(
      { ...query, after, limit },
      read,
    );
    if (page === 0) report.counts = got.counts;
    report.listed.push(...got.issues);
    after = got.next;
    if (after === null) break;
  }
  report.readCapped = after !== null;
  const started = await tracker.incompleteIssues(
    {
      ...query,
      limit,
      started: true,
    },
    read,
  );
  report.started = started.issues;
  report.startedMore = started.next !== null;
}

class SweepChanged extends Error {}

/** Revalidate after every paced wait, including retries; skip an issue a person has started or completed. */
async function stillEligible(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
  signal?: AbortSignal,
): Promise<void> {
  opts.writer.signal?.throwIfAborted();
  signal?.throwIfAborted();
  const now = await tracker.poolIssue(issue.identifier, signal);
  signal?.throwIfAborted();
  if (
    now === null ||
    now.truncated.length > 0 ||
    !["backlog", "unstarted"].includes(now.state.type)
  )
    throw new SweepChanged("issue is no longer eligible");
  const epic = now.labels.some(
    (l) => l.toLowerCase() === (opts.epic ?? "epic").toLowerCase(),
  );
  const missing = issue.missing.filter((f) =>
    f === "priority"
      ? now.priority === 0
      : (f !== "size" || !epic) && now[f] === null,
  );
  const labels = [...now.labels, ...(now.hiddenLabels ?? [])].map((l) =>
    l.toLowerCase(),
  );
  const retired = issue.retired.filter((l) => labels.includes(l.toLowerCase()));
  if (
    missing.length !== issue.missing.length ||
    retired.length !== issue.retired.length
  )
    throw new SweepChanged("issue fields changed since the census");
  opts.writer.signal?.throwIfAborted();
}

/** Whether the issue already carries the sweep's marker for what it lacks now. */
async function marked(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
): Promise<boolean> {
  const marker = sweepMarker(issue);
  const comments = await tracker.listComments(
    issue.identifier,
    opts.writer.signal,
  );
  return comments.some((c) => c.body.includes(marker));
}

/** Post the sweep's comment on one issue once it is still eligible. */
async function commentOn(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
  report: SweepReport,
): Promise<void> {
  await opts.writer.write(`comment on ${issue.identifier}`, async (signal) => {
    await stillEligible(tracker, issue, opts, signal);
    return tracker.postComment(
      issue.identifier,
      sweepComment(issue, report.move),
      signal,
    );
  });
  report.commented.push(issue.identifier);
}

/** Move one issue back to triage, its comment first unless a stopped run posted it. */
async function moveOne(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
  report: SweepReport,
): Promise<void> {
  const posted = await marked(tracker, issue, opts);
  if (!posted) await commentOn(tracker, issue, opts, report);
  await opts.writer.write(
    `move ${issue.identifier} to triage`,
    async (signal) => {
      await stillEligible(tracker, issue, opts, signal);
      return tracker.transition(issue.identifier, "triage", signal);
    },
  );
  report.moved.push(issue.identifier);
  opts.progress?.(
    `moved ${issue.identifier} to triage${posted ? " (its comment was already there)" : ""}`,
  );
}

/** Leave one issue in its state, commenting unless it already carries the marker. */
async function commentOne(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
  report: SweepReport,
): Promise<void> {
  if (await marked(tracker, issue, opts)) {
    report.marked.push(issue.identifier);
    return;
  }
  await commentOn(tracker, issue, opts, report);
  opts.progress?.(`commented on ${issue.identifier}, left in its state`);
}

/** Sweep one issue: `false` when a write stopped the run; an issue that changed is skipped. */
async function attempt(
  issue: IncompleteIssue,
  report: SweepReport,
  work: () => Promise<void>,
): Promise<boolean> {
  try {
    await work();
  } catch (err) {
    if (changed(err)) {
      report.skipped.push(issue.identifier);
      return true;
    }
    report.stopped =
      err instanceof WriteRefused
        ? err.message
        : failureLine(`sweep ${issue.identifier}`, err);
    return false;
  }
  return true;
}

function changed(err: unknown): boolean {
  return (
    err instanceof SweepChanged ||
    (err instanceof WriteRefused && err.cause instanceof SweepChanged)
  );
}

/** Sweep the open issues of `tracker`; a read that fails throws. */
export async function sweep(
  tracker: Tracker,
  opts: SweepOptions,
): Promise<SweepReport> {
  const stores = await tracker.facetStores({
    discovery: false,
    ...(opts.writer.signal === undefined ? {} : { signal: opts.writer.signal }),
  });
  const report: SweepReport = {
    stores: stores.facets.map((f) => ({
      facet: f.facet,
      store: f.store,
      why: f.why,
      ...(f.problem === undefined ? {} : { problem: f.problem }),
    })),
    storeProblem: storeProblems(stores),
    read: false,
    counts: {},
    listed: [],
    started: [],
    startedMore: false,
    readCapped: false,
    moved: [],
    skipped: [],
    commented: [],
    marked: [],
    stopped: null,
    apply: opts.apply,
    move: opts.move ?? true,
  };
  if (report.storeProblem !== null) return report;
  const missing = stores.facets
    .filter((f) => f.store !== null)
    .map((f) => f.facet);
  await readAll(
    tracker,
    { missing, retired: opts.retired(stores) },
    opts,
    report,
  );
  report.read = true;
  report.storeProblem = emptiedStore(report.counts);
  if (!opts.apply || report.storeProblem !== null) return report;
  const budget = opts.limits?.moves ?? SWEEP_LIMITS.moves;
  // Moving, every issue reached counts; without moving, a marked issue stays
  // in every listing, so it is passed over uncounted.
  const spent = () =>
    (report.move ? report.moved.length : report.commented.length) +
    report.skipped.length;
  const one = report.move ? moveOne : commentOne;
  for (const issue of report.listed) {
    if (spent() >= budget) break;
    if (
      !(await attempt(issue, report, () => one(tracker, issue, opts, report)))
    )
      break;
  }
  return report;
}

/** One line per issue, by key: what it lacks and the retired labels it carries. */
function issueLine(issue: IncompleteIssue): string {
  const parts = [
    issue.missing.length === 0 ? "" : `missing ${issue.missing.join(", ")}`,
    issue.retired.length === 0 ? "" : `retired ${issue.retired.join(", ")}`,
  ].filter((s) => s !== "");
  return `${issue.identifier}  ${issue.state.name}  ${parts.join("; ")}`;
}

/** Each facet's store, and the tracker's counts. */
function storeLines(report: SweepReport): string[] {
  const stores = report.stores.map(
    (s) =>
      `${s.facet}: ${s.store ?? "no store"} (${s.why})${s.problem === undefined ? "" : `: ${s.problem}`}`,
  );
  const counts = Object.entries(report.counts).flatMap(([facet, c]) =>
    c === undefined
      ? []
      : [
          `${facet}: ${c.lacking} of ${c.required} open issues outside triage lack it`,
        ],
  );
  return [...stores, ...counts];
}

/** The issues the read reached: those not yet started, then the started ones. */
function listingLines(report: SweepReport): string[] {
  const capped = report.readCapped ? ", and more past the read's page cap" : "";
  const more = report.startedMore ? ", and more than one page holds" : "";
  return [
    `${report.listed.length} incomplete issue(s) not yet started${capped}:`,
    ...report.listed.map((i) => `  ${issueLine(i)}`),
    `${report.started.length} incomplete issue(s) already started, listed and not moved${more}:`,
    ...report.started.map((i) => `  ${issueLine(i)}`),
  ];
}

/** What the run moved, what remains, and why it stopped. */
function outcomeLines(report: SweepReport): string[] {
  if (report.storeProblem !== null)
    return [`store problem, nothing moved: ${report.storeProblem}`];
  if (!report.apply)
    return [
      report.move
        ? "report only: nothing moved (--yes moves them to triage)"
        : "report only: nothing written (--yes comments on them, file_issue.sweep.move being false)",
    ];
  const remaining =
    report.listed.length -
    (report.move ? report.moved.length : report.commented.length) -
    report.marked.length -
    report.skipped.length;
  const capped = report.readCapped ? ", and more past the read's page cap" : "";
  const lines = [
    report.move
      ? `moved ${report.moved.length} to triage (${report.commented.length} commented on); ${remaining} remain${capped}`
      : `commented on ${report.commented.length}, moved none (file_issue.sweep.move is false); ${report.marked.length} already commented on; ${remaining} remain${capped}`,
  ];
  if (report.skipped.length > 0)
    lines.push(`changed during pacing, skipped: ${report.skipped.join(", ")}`);
  if (report.stopped !== null) lines.push(`stopped: ${report.stopped}`);
  else if (remaining > 0)
    lines.push(
      `the next run ${report.move ? "moves" : "comments on"} what remains past this run's cap`,
    );
  return lines;
}

/** The sweep's report as lines of text: keys, states, facets and labels only. */
export function sweepLines(report: SweepReport): string[] {
  if (report.storeProblem !== null && !report.read)
    return [
      ...storeLines(report),
      `store problem, nothing read or moved: ${report.storeProblem}`,
    ];
  return [
    ...storeLines(report),
    ...listingLines(report),
    ...outcomeLines(report),
  ];
}
