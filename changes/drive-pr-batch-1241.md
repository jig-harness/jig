---
release: patch
---

### Fixed

- `/jig:drive-pr`: on a converged head whose failures only cancelled runs carry, the driver log prints the recovery's wait line when the wait starts and when what it waits for changes (the head, or the failing checks), not on every 10-second poll, so a long grace period no longer fills the log with one line. The wait for a run to replace a cancelled check does the same.
