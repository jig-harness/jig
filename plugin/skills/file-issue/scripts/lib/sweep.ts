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
 * Its bounds: at most 20 pages of 100 issues read and 50 issues moved a run,
 * the writes paced (`pace.ts`); a refused write stops the run, which reports
 * what it moved and what remains. A store problem moves nothing: a store
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
  /** The labels of each facet the stores keep outside labels. */
  retired: (stores: FacetStores) => string[];
  writer: Writer;
  limits?: Partial<{ pages: number; pageSize: number; moves: number }>;
  /** Told of each issue as it is moved, by key, so a run cut short still shows what it did. */
  progress?: (line: string) => void;
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
  /** Commented on by this run (an issue a stopped run commented on is moved without one). */
  commented: string[];
  /** Why a write stopped the run, or `null`. */
  stopped: string | null;
  apply: boolean;
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

/** The comment that moves an issue back to triage, naming why. */
export function sweepComment(issue: IncompleteIssue): string {
  const lacks =
    issue.missing.length === 0
      ? ""
      : ` It has ${issue.missing.map((f) => `no ${f}`).join(", ")}: give it each one.`;
  const retired =
    issue.retired.length === 0
      ? ""
      : ` It carries labels this repository no longer keeps its type, priority or size in (${issue.retired.map((l) => `\`${l}\``).join(", ")}): set each value in the tracker's own field and remove the label.`;
  return `${sweepMarker(issue)}\nThe weekly issue-fields sweep moved this issue back to triage.${lacks}${retired} Then move it on.`;
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
  let after: string | null = null;
  for (let page = 0; page < pages; page++) {
    const got = await tracker.incompleteIssues({ ...query, after, limit });
    if (page === 0) report.counts = got.counts;
    report.listed.push(...got.issues);
    after = got.next;
    if (after === null) break;
  }
  report.readCapped = after !== null;
  const started = await tracker.incompleteIssues({
    ...query,
    limit,
    started: true,
  });
  report.started = started.issues;
  report.startedMore = started.next !== null;
}

/** Move one issue back to triage, its comment first unless a stopped run posted it. */
async function moveOne(
  tracker: Tracker,
  issue: IncompleteIssue,
  opts: SweepOptions,
  report: SweepReport,
): Promise<void> {
  const marker = sweepMarker(issue);
  const comments = await tracker.listComments(issue.identifier);
  const posted = comments.some((c) => c.body.includes(marker));
  if (!posted) {
    await opts.writer.write(`comment on ${issue.identifier}`, () =>
      tracker.postComment(issue.identifier, sweepComment(issue)),
    );
    report.commented.push(issue.identifier);
  }
  await opts.writer.write(`move ${issue.identifier} to triage`, () =>
    tracker.transition(issue.identifier, "triage"),
  );
  report.moved.push(issue.identifier);
  opts.progress?.(
    `moved ${issue.identifier} to triage${posted ? " (its comment was already there)" : ""}`,
  );
}

/** Sweep the open issues of `tracker`; a read that fails throws. */
export async function sweep(
  tracker: Tracker,
  opts: SweepOptions,
): Promise<SweepReport> {
  const stores = await tracker.facetStores({ discovery: false });
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
    commented: [],
    stopped: null,
    apply: opts.apply,
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
  const moves = opts.limits?.moves ?? SWEEP_LIMITS.moves;
  for (const issue of report.listed.slice(0, moves)) {
    try {
      await moveOne(tracker, issue, opts, report);
    } catch (err) {
      report.stopped =
        err instanceof WriteRefused
          ? err.message
          : failureLine(`sweep ${issue.identifier}`, err);
      break;
    }
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
    return ["report only: nothing moved (--yes moves them to triage)"];
  const remaining = report.listed.length - report.moved.length;
  const capped = report.readCapped ? ", and more past the read's page cap" : "";
  const lines = [
    `moved ${report.moved.length} to triage (${report.commented.length} commented on); ${remaining} remain${capped}`,
  ];
  if (report.stopped !== null) lines.push(`stopped: ${report.stopped}`);
  else if (remaining > 0)
    lines.push("the next run moves what remains past this run's cap");
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
