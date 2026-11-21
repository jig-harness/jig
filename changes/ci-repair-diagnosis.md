---
release: patch
---

### Fixed

- When a drive spends its CI-repair budget, it starts one diagnosing session on the failing head. The session compares the earlier repairs with the failed CI run, records the recurring cause in the tracker (or parks that filing for a person, which the drive verifies before accepting the diagnosis), and attempts the repair. Dispatch hands off an unresolved diagnosis with its tracker issue instead of repeating the same repair on that head.
