---
release: minor
---

### Added

- `/jig:drive-pr` stops with its own exit, `21` (`CI_REPAIR_SPENT`), when the
  review converged but CI still fails after its CI-repair passes, so a caller
  can tell that CI repair from a crash (`1`). A harness that reads exit `1`
  as "CI still red" reads `21` for a spent budget now; repair disabled
  (`DRIVE_PR_CI_REPAIR_ROUNDS=0`) still stops `1`.
- `jig dispatch` re-drives a stall (exit `14`) and a spent CI-repair budget
  (exit `21`) once per head commit, on any account, and tells a person when
  the same head stops the same way again. A stall that left work in its tree
  is re-driven only in that tree; with no open workspace holding it, a person
  is told. The re-armed drive's first pass is told the stop and, after a
  stall, what its passes recorded last, and it takes the edits the stall left
  as its own to finish.
- A stop the dispatcher hands a person says so when the pull request also
  conflicts with its base.

### Fixed

- A drive round that inherits a base merge an earlier pass left open, with its
  conflicts resolved but not committed, can now finish instead of stalling:
  `round-plan.ts` plans an open merge against the merge base its commit will
  have, so the pass can validate the merge before concluding it, and
  `/jig:drive-pr` tells the pass to finish what the tree holds (validate,
  commit, then sync the base and push) before the round's own work. A merge
  with a conflict still unresolved, and any other unfinished git operation,
  is still refused.
- The [ratchet](../modules/M1-gates-enforcement-ladder/reference/ratchet/README.md)
  measures a working tree in the middle of a merge against the merge base the
  merge commit will have, so a finding the target branch gained and the change
  merged in no longer counts as the change's.
- A stalled drive (exit `14`) tells its extra round what the tree holds, and
  its stop prints what that round's pass recorded: the refusal that stops the
  round now, not an earlier pass's. When that pass recorded nothing, the stop
  says the lines it prints predate it. A pass that ends a round without
  pushing names the step that refused and what would unblock it.
