---
release: minor
---

A served person's blocked items and assigned epics now keep the line moving.

### Added

- Dispatch starts the open blocker of a served item that nobody has assigned, so the item stops waiting on work no one is doing. A blocker qualifies when it is open, not started, unassigned, in this repository's scope, not an epic and free of `hitl`, `manual-ops` and `jig:hold`; blockers of blockers are followed to three links, and a pulled blocker is never batched. The blocked item reads "waiting on #N (picked up first)", and a blocker that does not qualify is named with its reason, for example "(assigned to sam)". `tracker.ts claim` takes `--blocking <item>` for such a pickup and re-reads the item's authority and the live `blocked_by` chain before it assigns the blocker to the served person. A tracker supports the pickup only when it assigns first, then can verify from history that it replaced nobody; when it finds a replaced concurrent assignee, it conditionally makes a best-effort restoration and refuses the pickup. GitHub Issues, Linear and Jira do so.
- An epic none of whose open children can start reports one reason: how many children it has and the first one's hold.

### Changed

- An assigned epic without an execution plan works one child at a time, the top-ranked one, and none while a child of it is in progress, as `do-item` works an epic. An execution plan that lists several eligible steps keeps its parallelism.
- A served item held by an open blocker names the blocker's assignee or state in the Queue view instead of only its key.
- A pulled blocker's claim re-reads the epic execution plans of the item it blocks, the blocker itself and every item between, with the plan block named by the default branch's configuration. A tracker that cannot assign still names each blocker's own reason.
