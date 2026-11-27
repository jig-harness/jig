---
release: patch
---

### Fixed

- `/jig:drive-pr`: on a converged head whose failures only cancelled runs carry, the driver log prints the recovery's wait line when the wait starts and when what it waits for changes (the head, or the failing checks), not on every 10-second poll, so a long grace period no longer fills the log with one line. The wait for a run to replace a cancelled check does the same.
- `/jig:drive-pr`: the skill's exit table, its CI-repair sections, the re-arm banner and the README no longer say a spent CI-repair budget stops the drive by itself. A spent budget starts one diagnosing session on the failing head, `CI_REPAIR_SPENT` (exit 21) is the stop when that session could not complete the repair, and a re-arm on the same head stops again with the recorded diagnosis unless the park it named was answered, as the exit registry says.
