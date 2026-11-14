---
release: minor
---

Every call to the forge and the issue trackers now fails as one of the defined failure classes, and the dispatcher waits out the ones that clear by waiting instead of failing a tick or asking a person.

### Added

- The forge's and the trackers' failed calls are each one of a closed set of [failure classes](../GLOSSARY.md): `rate-limited` (with the time it clears), `unreachable`, `too-costly`, `server-fault`, `unauthorized`, `not-found` and `invalid`. The shared library `plugin/shared/outbound/` defines the classes and classifies the forge's and GitHub's answers; the Linear and Jira transports classify their own responses into them. Every caller reads the class, never a status or a message. [The configuration reference](../plugin/CONFIGURATION.md#when-an-outside-system-refuses-or-does-not-answer) has each class's policy.
- `tracker.ts` exits with one code per class: `5` for a spent rate limit, as before, with its `RATE-LIMITED until <time>` line, then `6` unreachable, `7` too costly, `8` server fault, `9` unauthorized, `10` not found and `11` invalid, the class named at the start of the error line. A failure no call to the tracker caused still exits `1`. [do-item's tracker operations](../plugin/skills/do-item/SKILL.md#tracker-operations) list them. **Consumer action:** advised at instructions. A runbook or script that reads `tracker.ts`'s exit `1` as every failure reads `6` to `11` as failures too.
- A follow-up pass that meets the forge's or the tracker's rate limit records `waits --until <reset>` and asks nobody. The dispatcher leaves its marker until the reset, then starts the follow-up again as a first run; the third such wait in a row goes to a person as a failed follow-up, naming the rate limit.

### Changed

- One retry for every tracker read: a read the tracker did not answer, or answered with a 5xx fault, is sent once more after a backoff of about a second, within the call's deadline, honouring `Retry-After`. The Linear transport had no retry and now has it; the GitHub and Jira transports sent a read up to four times on HTTP 429 and 503, and now send it at most twice, and never again after a 429. A write is never sent twice.
- A tick no longer exits 1 for a repository whose every failed read clears by waiting. A rate-limited read is no failure before its reset and is not counted in the failure ledger; an unreachable, timed-out or faulting forge or tracker fails the tick only once the repository's failures in a row reach `failures.notify_after`. The report shows the forge's last reading of that repository with its time and its age. A refused credential is told to a person at once.
- A forge or tracker that did not answer receives no further request in the same tick, and the next tick sends it one request alone before it reads on. The holds outlive the tick in `~/.local/state/jig/dispatch/unanswered.json`, and the tick's receipt names each held system (`unanswered`).
