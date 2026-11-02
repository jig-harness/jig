---
release: minor
---

The dispatcher re-drives a converged pull request that went stale.

### Added

- **Re-drive of a stale converged pull request.** `jig dispatch` now reads
  each open pull request's mergeability and head commit with the pull
  request. A drive that converged (`drive.ts` exit `0`) whose pull request
  the forge now reports conflicting with its base, or whose head moved past
  the head the drive verified, is classed `stale`, and the `rearm` stage
  re-arms it on any admitted account, once per change (the pull request's
  head, conflicting or not): the drive merges the base in through its
  conflict-resolve round, or reviews the new head in its ordinary rounds.
  A pull request its base merely moved past, still mergeable at the
  verified head, is left alone, and one whose mergeability the forge is
  still computing is reported unplaced for that run, with nothing launched.
  The re-drive's row in the outcome log ends like any re-arm's, with a
  reason that names why the drive was stale.
