/**
 * What a need about a run takes from the run's closing report
 * (`closing-report-store.ts`), so *What needs you* shows the report's
 * `question` and `decision` where it shows a pass's `Question:` line and
 * framed result, with its `concluded` beside them as context. What raises a
 * need is unchanged: a report changes what the need says, never whether
 * there is one.
 */
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { KeptReport } from "./closing-report-store.ts";
import type { FramedResult } from "./framed-result.ts";

/** The question the run's report asks, else `asked`, the question the need was raised on. */
export function reportQuestion(
  kept: KeptReport | null | undefined,
  asked: string,
): string {
  return kept?.report.question ?? asked;
}

/**
 * The decision a need shows, taken with its question: a report that asks a
 * question brings its own decision (none when it framed none, never the
 * pass's framed result of another question); otherwise the pass's framed
 * result, else the report's decision; none without either.
 */
export function reportFramed(
  framed: FramedResult | undefined,
  kept: KeptReport | null | undefined,
): FramedResult | undefined {
  const decision = kept?.report.decision;
  const fromReport =
    kept == null || decision === undefined
      ? undefined
      : { decision, digest: decisionDigest(decision), at: kept.at };
  if (kept?.report.question !== undefined) return fromReport;
  return framed ?? fromReport;
}

/** The evidence a need carries of its run's report: what it concluded; nothing without a report. */
export function reportEvidence(kept: KeptReport | null | undefined): {
  concluded?: string;
} {
  return kept == null ? {} : { concluded: kept.report.concluded };
}
