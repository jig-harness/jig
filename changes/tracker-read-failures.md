---
release: patch
---

### Fixed

- `get_issue.ts` reports refused or unreachable tracker reads as unreadable, without key or team suggestions. Its JSON distinguishes `read-failed` from `not-found`, while both keep exit 2 and `found: false` for existing callers.
