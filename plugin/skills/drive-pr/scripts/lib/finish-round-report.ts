/** The round finisher's report shared by its emitters. */
type ItemAction = "resolved" | "left-open" | "answered" | "refused";

export interface ItemResult {
  key: string;
  kind: string;
  action: ItemAction;
  /** The refusing script's exit code; 0 on success. */
  code: number;
  /**
   * That script's own stderr, verbatim — never re-worded here. The one
   * exception: an item that exhausted the retry/read bounds without ever
   * being dispatched has no script's stderr to carry, so its diagnostic is
   * synthesized instead (see the post-drain verification block).
   */
  diagnostic?: string;
}

export interface Report {
  pr: number;
  head: string;
  state:
    | "FINISHED"
    | "REFUSED_UNCLEAN"
    | "REFUSED_UNTRIAGED"
    | "TRIAGE_CHECK_FAILED"
    | "PR_NOT_OPEN"
    | "PUSH_FAILED"
    | "CI_HOLD_WAIT"
    | "CI_HOLD_FAILED"
    | "HITL_PARKED"
    | "STAMP_FAILED"
    | "HEAD_NOT_SYNCED"
    | "BATCH_UNREADABLE"
    | "PARTIAL"
    | "LEASE_HELD";
  reason: string;
  pushed: boolean;
  stamped: boolean;
  headSynced: boolean;
  items: ItemResult[];
}
