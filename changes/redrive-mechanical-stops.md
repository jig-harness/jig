---
release: minor
---

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
