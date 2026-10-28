---
release: patch
---

### Changed

- A CI hold's held-head check, when it sits in the required job itself, may
  cancel its own run instead of failing it
  ([M13 § Hold](../modules/M13-pipeline-economy/README.md#7-hold)). A
  cancelled required check blocks the merge as a failed one does, but once
  the release passes, the head the merge waits for lists the held run as
  cancelled rather than as a red failed check. The shape, with the
  `actions: write` permission it needs and the failure it falls back to, is
  in [M13's mappings](../modules/M13-pipeline-economy/mappings.md#hold);
  drive-pr's CI-hold setup, the audit's `ci-hold-fails-held-heads` probe and
  the workflow-convention lint accept it.
