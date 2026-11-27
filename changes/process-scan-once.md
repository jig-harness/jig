---
release: patch
---

### Fixed

- With `runtime: process`, a dispatch tick no longer scans the host's processes once per worktree, each scan a blocking spawn on the event loop every repository's observe shares. Listing a repository's sessions scans once, without blocking, and every worktree is judged on that one answer, so a small repository's runtime phase no longer waits behind other repositories' scans. The holders found and the handling of an incomplete scan are unchanged. To see the effect, read the `runtime` figure of each repository's `took` line in `jig receipts dispatch <date>` before and after the upgrade. **Consumer action:** none.
