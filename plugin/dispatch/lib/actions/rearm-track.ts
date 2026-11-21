import type { DrivenPr, LaunchOutcome, RepoReport } from "../types.ts";
import type { ApplyState } from "./launch.ts";
import { clearRearmWait } from "../rearm-waits.ts";
import {
  failedRearmRequest,
  rearmBlockExpired,
  reportRearmCapacity,
} from "./retire-rearm.ts";

/** What a launch records about an explicit rearm request while it waits and when it advances. */
export interface RearmTrack {
  /** The stopped driver's tree is missing: age the wait, and fail the request once it has lasted long enough. */
  treeMissing(reason: string): void;
  /** A refused tree proof: only a structural mismatch ages the wait. */
  treeRefused(reason: string, structural: boolean | undefined): void;
  /** Admission found no capacity. */
  capacity(outcome: LaunchOutcome, capacity: "accounts" | "load"): void;
  /** One wait ended because its step passed. */
  passed(kind: "capacity" | "tree" | "stop"): void;
}

/** The tracker for the pull request's explicit rearm request, or `null` for any other launch. */
export function rearmTrack(
  state: ApplyState,
  slug: string,
  pr: DrivenPr,
  report: RepoReport,
): RearmTrack | null {
  const request = pr.evidence.rearmRequestId;
  if (pr.evidence.rearm !== true || typeof request !== "number") return null;
  const age = (reason: string) => {
    if (rearmBlockExpired(state, slug, pr, "tree", reason))
      failedRearmRequest(report, slug, pr, reason);
  };
  return {
    treeMissing: age,
    treeRefused: (reason, structural) => {
      if (structural === true) age(reason);
    },
    capacity: (outcome, capacity) =>
      reportRearmCapacity(state, slug, pr, outcome, capacity),
    passed: (kind) =>
      clearRearmWait({ repo: slug, pr: pr.number, request, kind }, state.root),
  };
}
