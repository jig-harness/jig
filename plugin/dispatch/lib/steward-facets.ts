/** A steward fills only a missing facet of an assignment it observed. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type {
  Facet,
  IssuePatch,
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { queueHold } from "./queue-rank.ts";

interface FacetRecord {
  kind: "facet";
  target: string;
  facet: Facet;
  value: string | number;
  reason: string;
}
type FacetTracker = Pick<Tracker, "poolIssue" | "postComment" | "updateIssue">;

/**
 * Record intent before the mutation, then re-read at the write boundary.
 * A changed assignment, a partial read or a nonempty unmapped store refuses
 * the write. Tracker failures stay visible rather than looking like a skip.
 */
export async function applyStewardFacet(
  tracker: FacetTracker,
  record: FacetRecord,
  queue: readonly PoolIssue[],
  policy: { hitl?: string; manualOps?: string } = {},
): Promise<Outcome<"applied" | "skipped">> {
  const observed = queue.find((i) => i.identifier === record.target);
  const patch = facetPatch(record);
  if (!observed || patch === null)
    return failed("invalid", "the steward facet or assigned target is invalid");
  if (!writable(observed, observed, record.facet, policy)) return ok("skipped");
  const signal = AbortSignal.timeout(60_000);
  try {
    const current = await tracker.poolIssue(record.target, signal);
    if (!writable(current, observed, record.facet, policy))
      return ok("skipped");
    await tracker.postComment(
      record.target,
      `Steward proposes filling the missing ${record.facet} with ${String(record.value)}. ${record.reason}\n\nThe value is written only if it is still empty when read immediately before the update.`,
      signal,
    );
    const latest = await tracker.poolIssue(record.target, signal);
    if (!writable(latest, observed, record.facet, policy)) return ok("skipped");
    await tracker.updateIssue(record.target, patch, signal);
    return ok("applied");
  } catch (cause) {
    return failed(
      "tracker",
      `the steward could not read or fill the missing facet: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

function writable(
  issue: PoolIssue | null,
  observed: PoolIssue,
  facet: Facet,
  policy: { hitl?: string; manualOps?: string },
): boolean {
  return (
    issue !== null &&
    issue.identifier === observed.identifier &&
    observed.assignee !== null &&
    issue.assignee?.id === observed.assignee.id &&
    ["triage", "backlog", "unstarted"].includes(issue.state.type) &&
    !issue.unmappedFacets?.includes(facet) &&
    queueHold({ issue, blockers: [], unblocks: 0 }, policy) === null &&
    (facet === "priority" ? issue.priority === 0 : issue[facet] === null)
  );
}

function facetPatch(record: FacetRecord): IssuePatch | null {
  if (!record.reason.trim() || record.reason.length > 4_000) return null;
  if (record.facet === "priority")
    return typeof record.value === "number" &&
      Number.isInteger(record.value) &&
      record.value >= 1 &&
      record.value <= 4
      ? { priority: record.value }
      : null;
  if (
    (record.facet === "type" || record.facet === "size") &&
    typeof record.value === "string" &&
    record.value.trim() === record.value &&
    record.value.length > 0 &&
    record.value.length <= 100 &&
    !/[\r\n]/.test(record.value)
  )
    return { [record.facet]: record.value };
  return null;
}
