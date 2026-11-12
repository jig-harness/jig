---
release: minor
---

### Added

- The dispatcher can pick up from a ready pool: set `dispatch.pool.states`
  and the unassigned open items in those states (inside
  `issue_tracker.jira.pool_issue_types` on Jira) are pickups beside the
  items assigned to `dispatch.identity`, ranked by the queue's rules. An
  item is picked up only when the latest move into its state was made by a
  person who can write to the repository (its creator, where it was created
  there; on Jira never an app's account, Jira Automation's included); an
  item anyone else made ready shows in the Queue view with who moved it and
  never starts. The pickup's claim assigns the item to the factory identity,
  so `do_item.preflight_command`, `do_item.claim_from` and the claim marker
  apply. A pool is refused without `dispatch.identity` and without
  `do_item.claim_marker: true`, the token that decides between hosts taking
  from the same pool. On GitHub, a pool state on a board needs the
  `Status` field, whose changes GitHub records.
- The tracker interface reads a ready pool on GitHub Issues, Linear and
  Jira: the open issues assigned to nobody in given states
  (`unassignedIssues`), and who made an issue's latest move into its
  current state (`stateChangedBy`), with that person's trust as
  `assignedBy` judges an assigner.
- The audit warns when `dispatch.pool.states` names a state
  `do_item.claim_from` refuses.
