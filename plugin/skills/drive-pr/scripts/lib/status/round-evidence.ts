/**
 * What one round's live findings contribute to the recorded round evidence:
 * the files they anchor to (`openThreadPaths`, for `structuralEscalationDue`
 * and the structural-churn brake) and whether any of them is `high` or
 * `blocker` (`roundSevere`, which keeps a round of real work from counting
 * toward the brake's same-file streak).
 *
 * The caller passes the findings already filtered (parked, held, left open
 * and standing provisional ones removed), so the two facts are read over
 * the same set.
 */
import { type LabelledRecord, severityOfRecord } from "../record-labels.ts";
import type { UnresolvedThread } from "./evidence.ts";

/** A summary-only finding as far as the round evidence reads it. */
interface SummaryFindingLike {
  path: string;
  severity: string;
}

const SEVERE = new Set(["high", "blocker"]);

/**
 * The paths and the severity fact of one round's live findings.
 *
 * Set semantics, matching what `normalizeRoundPaths` will store: three
 * findings on one file in one round is one file. Non-string and empty
 * `path`s are dropped rather than stringified — a PR-level thread has
 * `path: null`, and `"null"` is not a file; an `unaccounted` summary
 * finding has `path: '(unknown)'`, a sentinel that names no file either.
 *
 * `.trim()` is used ONLY to detect a whitespace-only path, never to
 * transform the stored identity: two legitimate, distinct repository paths
 * can differ only by leading or trailing whitespace (`a.ts` vs ` a.ts`), and
 * trimming both would alias them to one recurrence key, arming
 * `structuralEscalationDue` on findings from two different files.
 *
 * A finding with no path still counts toward `severe`: a `high` finding on
 * the pull request as a whole is real work all the same. An unknown
 * severity counts as not severe.
 */
export function roundEvidence(
  threads: readonly UnresolvedThread[],
  summary: readonly SummaryFindingLike[],
): { paths: string[]; severe: boolean } {
  const paths = [
    ...new Set([
      ...threads
        .map((t) => (t as { path?: unknown }).path)
        .filter((p): p is string => typeof p === "string" && p.trim() !== ""),
      ...summary
        .map((f) => f.path)
        .filter(
          (p): p is string =>
            typeof p === "string" && p.trim() !== "" && p !== "(unknown)",
        ),
    ]),
  ].sort();
  const severe =
    threads.some((t) => SEVERE.has(severityOfRecord(t as LabelledRecord))) ||
    summary.some((f) => SEVERE.has(f.severity));
  return { paths, severe };
}
