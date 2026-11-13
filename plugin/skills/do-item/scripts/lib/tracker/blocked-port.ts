/**
 * The tracker port's operations on the fields a blocked item carries
 * (`issue_tracker.jira.blocked_fields`), which the drive-ledger projection
 * (`../blocked-move.ts`) writes; only the Jira adapter has them.
 */

/** Why and since when an item is blocked, as the blocked fields carry it. */
export interface BlockedFields {
  /** One line: the park class and its reason. */
  reason: string;
  /** ISO 8601, UTC. */
  since: string;
}

/** The blocked fields' operations, each absent on an adapter with no such fields. */
export interface TrackerBlockedFields {
  /**
   * Write the fields a repository names for a blocked item
   * (`issue_tracker.jira.blocked_fields`), or clear them with `null`.
   * Absent on an adapter with no such fields; `false` when the repository
   * names none, or `except` holds every one it names, so nothing was
   * written.
   */
  writeBlockedFields?(
    key: string,
    value: BlockedFields | null,
    signal?: AbortSignal,
    except?: ReadonlyArray<keyof BlockedFields>,
  ): Promise<boolean>;
  /**
   * Move an issue to `blocked`, sending with the move each blocked field
   * the transition's screen carries, so a workflow that requires one on
   * the way in accepts the move. Resolves to the roles sent; the caller
   * writes the rest with `writeBlockedFields`. A refusal names the
   * transition and which fields went with it. Present where
   * `writeBlockedFields` is.
   */
  transitionBlocked?(
    key: string,
    value: BlockedFields,
    signal?: AbortSignal,
  ): Promise<Array<keyof BlockedFields>>;
}
