---
release: patch
---

### Fixed

- drive-pr's divergence stop parked drives that were converging. A round now
  diverges only when it raises more review findings than it fixes, so a round
  that raises as many as it fixes no longer counts. Backlog findings the
  reviewer renders in its not-blocking *Beyond this PR* section are no longer
  counted, even when that section abbreviates them. Convergence still asks for
  an answer to such an entry. The status JSON lists these entries under
  `work.summaryNotBlockingKeys`. The round ceiling and the two diverging rounds
  that park are unchanged.
