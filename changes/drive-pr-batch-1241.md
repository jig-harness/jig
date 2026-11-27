---
release: minor
---

### Fixed

- `/jig:drive-pr`: on a converged head whose failures only cancelled runs carry, the driver log prints the recovery's wait line when the wait starts and when what it waits for changes (the head, or the failing checks), not on every 10-second poll, so a long grace period no longer fills the log with one line. The wait for a run to replace a cancelled check does the same.
- `/jig:drive-pr`: the skill's exit table, its CI-repair sections, the re-arm banner and the README no longer say a spent CI-repair budget stops the drive by itself. A spent budget starts one diagnosing session on the failing head, `CI_REPAIR_SPENT` (exit 21) is the stop when that session could not complete the repair, and a re-arm on the same head stops again with the recorded diagnosis unless the park it named was answered, as the exit registry says.
- `/jig:drive-pr`: when the round-boundary takeover check rejects the ledger's comment listing (a transport failure, a blank, malformed, interrupted or truncated page set, a driver with no ledger floor), the driver log now names the reason once per run of rejections for that reason. The check still reads the listing again at the next checkpoint, so a drive that keeps retrying it is visible in its log.
- `/jig:drive-pr`: a stall stop now says how its passes finished when they did not all end on the same state: the last reasons their `finish-round.ts` recorded and how many passes recorded none. The stall's `stop` event keeps that tally as `reasons`, and the ledger's summary, the closing report and the dispatcher's account of the stalled drive, which the steward's digest carries, name it, so a stall re-drive, the steward or a person starts from what the passes said.
