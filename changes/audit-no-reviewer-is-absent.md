---
release: patch
---

### Fixed

- The audit scored a repository with no automated pull-request reviewer as
  `expected-absent` on M7's reviewer criteria, which counts as met, so it
  could reach M7 Standard without a reviewer and was never told to add one.
  M7's criteria now ask, at Standard, that at least one automated reviewer
  start comment-only under a written precision bar (one already promoted shows the bar it cleared), and the criteria about
  where that reviewer's runtime and policy come from and how it is promoted
  to blocking are no longer met by having no reviewer; the lint that keeps a
  reviewer workflow bearing a secret off fork code is a gap while no lint
  runs, even with no privileged trigger in use. The
  [criteria format's Scoring section](../plugin/skills/audit/criteria/README.md#scoring)
  says a practice not adopted yet is a gap whichever module asks for it,
  names a missing automated reviewer among the cases that recur, and the
  audit's survey and methodology guidance agree. A re-audit of a repository
  with no reviewer shows these criteria as `absent`, an M7 gap under
  Team/Standard. **Consumer action:** none.
