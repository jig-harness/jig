---
release: patch
---

### Fixed

- The review drive recovers a cancelled workflow with no active replacement
  after a short grace period, requesting one re-run per head with a durable
  budget shared across re-arms. An unsafe or refused request, or another
  cancellation, parks with the run and recovery steps for a person instead of
  repeating the initial CI wait. The doctor names that recovery. A completed
  later attempt also replaces an old cancelled matrix template whose expanded
  jobs have different names.
