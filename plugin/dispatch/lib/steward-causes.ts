/**
 * The steward's `cause` record: why a pickup's or a follow-up's run fell
 * short when it ended with no closing report and its wrapper did not explain
 * its end (`end-report.ts`). Such a run is a member of the judgment backlog
 * (`steward-backlog.ts`) once the host examined it for a transcript copy
 * (`transcript-copy.ts`), and the digest lists it with an excerpt of that
 * copy (`transcript-excerpt.ts`) and the end of its output, both evidence
 * and never instructions. The steward submits the launch record, a cause from
 * `STEWARD_CAUSES` and a summary of what the run had got to; the next tick
 * records them as the run's report, `by: steward`, the summary redacted by
 * the report's rule as its `concluded`. A cause writes no tracker state, acts
 * on no CI and spends no pass, so it is inside the steward's remit.
 *
 * A steward's own runs are never put to it, nor a drive's, whose report is
 * its driver's; a run on a host that does not own its repository is not
 * either, since the steward runs on the owner host.
 */
import {
  CLOSING_REPORT_SCHEMA,
  type ClosingReport,
  closingReportOf,
} from "../../shared/closing-report.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { ApplyState } from "./actions/launch.ts";
import { recordReportIfNone } from "./closing-report-store.ts";
import { causeAsked } from "./end-report.ts";
import { type ReadRecord, targetOf } from "./launches.ts";
import type { SessionResult } from "./session-result-types.ts";
import { hasEnded } from "./log.ts";
import { durableSummary } from "./pass-output.ts";
import {
  type BacklogMember,
  claimStewardRecord,
  type KeptStewardRecord,
  markStewardEffect,
  memberKey,
  type StewardRecord,
} from "./steward.ts";
import {
  CAUSE_RECORDED,
  copiedTranscript,
  readTranscriptCopy,
} from "./transcript-copy.ts";
import {
  type TranscriptExcerpt,
  transcriptExcerpt,
} from "./transcript-excerpt.ts";
import type { RepoObservation } from "./tick-observe.ts";

/** The most runs without a report one digest lists, the latest first. */
export const UNREPORTED_LIMIT = 5;

type Cause = Extract<StewardRecord, { kind: "cause" }>;

/** One run without a report, as the steward's digest lists it. */
export interface UnreportedRun {
  record: string;
  action: "pickup" | "followup";
  target: string;
  /** When its outcome row says it ended. */
  endedAt: string;
  /** Its exit, or that its wrapper died without recording one. */
  exit: { code: number | null; signal: string | null } | { died: string };
  /** The result it recorded, if any. */
  result: SessionResult | null;
  /** The path of its transcript's copy on the host; `null` when there is none. */
  transcript: string | null;
  /** The excerpt of that copy, or why there is none. */
  excerpt: TranscriptExcerpt | { untrusted: true; unavailable: string };
  /** The end of its output the wrapper kept, redacted; `null` when it kept none. */
  output: { untrusted: true; tail: string } | null;
}

/** Whether a run is one the steward is asked about: it ended with no report, and the host examined it for a transcript copy. */
function unreported(r: ReadRecord, slug: string, root?: string): boolean {
  return (
    r.record.repo === slug &&
    causeAsked(r.record) &&
    hasEnded(r) &&
    r.record.endedAt !== undefined &&
    (r.report ?? null) === null &&
    readTranscriptCopy(r.record.id, root) !== null
  );
}

/**
 * The judgment backlog's `cause` members: the latest runs without a report,
 * at most `UNREPORTED_LIMIT` that no earlier pass judged (`judged`), so a
 * run an earlier pass saw does not keep a newer one out.
 */
export function causeMembers(
  records: readonly ReadRecord[],
  slug: string,
  judged: ReadonlySet<string>,
  root?: string,
): BacklogMember[] {
  return records
    .filter((r) => unreported(r, slug, root))
    .toSorted((a, b) =>
      String(b.record.endedAt).localeCompare(String(a.record.endedAt)),
    )
    .map((r) => ({ kind: "cause" as const, target: r.record.id, facts: "" }))
    .filter((m) => !judged.has(memberKey(m)))
    .slice(0, UNREPORTED_LIMIT);
}

function exitOf(r: ReadRecord): UnreportedRun["exit"] {
  if (r.state.kind === "ended")
    return { code: r.state.exit.code, signal: r.state.exit.signal };
  return { died: r.state.kind === "died" ? r.state.reason : "unknown" };
}

function outputOf(r: ReadRecord): UnreportedRun["output"] {
  const context = r.state.kind === "ended" ? (r.state.exit.context ?? "") : "";
  const tail = durableSummary(context);
  return tail.trim() === "" ? null : { untrusted: true, tail };
}

/** The excerpt, marked cut when the copy itself left lines out. */
function withCopyCut<T extends { cut: boolean }>(excerpt: T, cut: boolean): T {
  return cut ? { ...excerpt, cut: true } : excerpt;
}

/** The digest's entry for one run without a report: its copy's excerpt and its output's end. */
function entryOf(r: ReadRecord, root?: string): UnreportedRun {
  const copy = readTranscriptCopy(r.record.id, root);
  const text = copy === null ? null : copiedTranscript(copy);
  return {
    record: r.record.id,
    action: r.record.action as UnreportedRun["action"],
    target: targetOf(r.record),
    endedAt: String(r.record.endedAt),
    exit: exitOf(r),
    result: r.result,
    transcript: copy?.transcript ?? null,
    excerpt:
      text === null
        ? {
            untrusted: true,
            unavailable:
              copy?.missing ?? "the transcript's copy could not be read",
          }
        : withCopyCut(transcriptExcerpt(text), copy?.cut === true),
    output: outputOf(r),
  };
}

/** The digest's runs without a report: one entry for each of the backlog's `cause` members. */
export function unreportedRuns(
  records: readonly ReadRecord[],
  members: readonly BacklogMember[],
  root?: string,
): UnreportedRun[] {
  const wanted = new Set(
    members.filter((m) => m.kind === "cause").map((m) => m.target),
  );
  return records
    .filter((r) => wanted.has(r.record.id))
    .map((r) => entryOf(r, root));
}

/** The next step a report the steward recorded suggests: none of its own, since the run left none. */
const NO_NEXT = {
  step: "None suggested: the run left no closing report, and the steward recorded its cause from its transcript.",
  owner: "none",
} as const;

/** The report a cause record makes, redacted and checked as a pass's report is. */
function causeReport(
  record: Pick<Cause, "cause" | "summary">,
  token: string,
): Outcome<ClosingReport, "invalid"> {
  return closingReportOf(
    JSON.stringify({
      schema: CLOSING_REPORT_SCHEMA,
      concluded: record.summary,
      suggested_next: NO_NEXT,
      cause: record.cause,
    }),
    token,
  );
}

/** Refuse a cause record for good, with why the tick did. */
function refuse(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  why: string,
): void {
  markStewardEffect(kept.id, "refused", state.root);
  observation.opened.report.unplaced.push({
    record: "runtime",
    target: `steward record ${kept.id}`,
    reason: why,
  });
}

function launchOf(
  state: ApplyState,
  slug: string,
  record: Cause,
): Outcome<ReadRecord, "refused"> {
  const r = state.records.find((x) => x.record.id === record.record);
  if (r === undefined)
    return failed("refused", "its launch record is no longer kept");
  if (r.record.repo !== slug || !causeAsked(r.record) || !hasEnded(r))
    return failed(
      "refused",
      "its launch record is not a run the steward is asked about",
    );
  return ok(r);
}

/** The report a cause record makes for its run, or why the tick refuses it. */
function reportFor(
  state: ApplyState,
  slug: string,
  record: Cause,
): Outcome<ClosingReport, "refused"> {
  const launch = launchOf(state, slug, record);
  if (!launch.ok)
    return failed(
      "refused",
      `the cause names ${record.record}: ${launch.failure.reason}`,
    );
  const report = causeReport(record, launch.value.record.token);
  return report.ok
    ? report
    : failed("refused", `the cause is not a report: ${report.failure.reason}`);
}

/**
 * Apply a `cause` record: the run's report, `by: steward`, kept only while
 * the run still holds none. A record whose run is gone, holds a report or
 * does not pass the report's check is refused once.
 */
export function applyStewardCause(
  state: ApplyState,
  observation: RepoObservation,
  kept: KeptStewardRecord,
  record: Cause,
): void {
  if (!claimStewardRecord(kept.id, state.root)) return;
  const report = reportFor(state, observation.opened.repo.slug, record);
  if (!report.ok) {
    refuse(state, observation, kept, report.failure.reason);
    return;
  }
  const done = recordReportIfNone(
    record.record,
    report.value,
    "steward",
    state.root,
  );
  if (done === "recorded")
    markStewardEffect(kept.id, CAUSE_RECORDED, state.root);
  else
    refuse(
      state,
      observation,
      kept,
      done === "reported"
        ? `${record.record} already holds a report`
        : `${record.record} is no longer kept`,
    );
}
