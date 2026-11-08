/**
 * The GitHub default's rules: which store a facet whose store the
 * configuration does not name would be kept in, from what detection read
 * of the tracker (design/tracker-facets.md, "Defaults per adapter").
 *
 * - Labels of the facet on any issue, open or closed, are evidence for the
 *   label store; a value in the tracker's own field (an issue type, an issue
 *   field's value) is evidence for that store, whatever wrote it.
 * - Both together are a conflict, never resolved by guessing.
 * - One alone selects its store.
 * - Neither selects the tracker's own field where it qualifies (issue types
 *   named like the types, a Priority field whose options name the
 *   priorities, an Effort field whose options are the sizes), else labels.
 *
 * In this release detection only reports: every facet a repository does not
 * name stays in the store it has today, and `facetStores()` shows what the
 * rules would select. A detection read that fails is an error carried to
 * the caller, never read as "the organization has no field".
 */

import type { FacetDetection, FacetStoreKind } from "../port.ts";

/** What detection read for one facet. */
export interface Evidence {
  labelEvidence: boolean;
  nativeEvidence: boolean;
  /** The store the facet could move to; `null` for none. */
  candidate: { store: FacetStoreKind; field?: string } | null;
  /** Why the tracker's own field does not qualify, when it does not. */
  candidateProblem?: string;
}

/** The store the rules select from `evidence`, or a conflict. */
export function wouldSelect(evidence: Evidence): FacetStoreKind | "conflict" {
  const native = evidence.candidate?.store ?? "native";
  if (evidence.labelEvidence && evidence.nativeEvidence) return "conflict";
  if (evidence.labelEvidence) return "label";
  if (evidence.nativeEvidence) return native;
  return evidence.candidate === null ? "label" : evidence.candidate.store;
}

/** A detection result as `facetStores()` reports it. */
export function detection(evidence: Evidence): FacetDetection {
  return {
    status: "read",
    labelEvidence: evidence.labelEvidence,
    nativeEvidence: evidence.nativeEvidence,
    candidate: evidence.candidate,
    ...(evidence.candidateProblem === undefined
      ? {}
      : { candidateProblem: evidence.candidateProblem }),
    wouldSelect: wouldSelect(evidence),
  };
}
