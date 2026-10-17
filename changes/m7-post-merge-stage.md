---
release: minor
---

M7 now covers what happens after the merge.

### Added

- M7's lifecycle template gains a post-merge stage, "what does the merge still
  owe?": after every merge, each class of residual obligation (the tracker
  state, deferred findings, out-of-tree actions, temporary scaffolding, live
  verification and the next step) is settled as owed, and filed or done, or as
  not owed, with the evidence that settled it. A deferred reply is checked
  against the tracker, since the unresolved-threads gate can see that a reply
  names a reference but not that the item behind it exists. The next step is
  picked with a bias toward closure.
- Both human-in-the-loop registry templates (M7's and M0's) gain two rows:
  picking the next item from the computed ranking, and reopening on a
  rejecting verdict or waiving a missing acceptance review, which needs an
  approver other than whoever runs the sweep.
- A criterion in the audit's M7 file, `post-merge-obligations-settled`, at the
  Standard level. A repository that has the practice scores it from its
  lifecycle document and its recent merges; one that does not gains a
  recommendation.
