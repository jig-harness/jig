---
release: patch
---

### Changed

- `/jig:operator` answers a status question (where a pull request, a tracker item or a follow-up stands) as the same card every time: `jig ask`'s own answer as it printed it, then four lines saying where the work stands, what it waits on, what you can do (with the drive doctor's recovery command quoted for you to run) and what the answer could not read. `/jig:operator 456` is that status for pull request 456, or for issue 456 when no pull request has that number.
- `/jig:operator` on its own lists what waits on a person as a fixed card too: one block per repository, one line per entry with the act that settles it and since when, the question quoted where an entry names one, and a closing line saying running drives are not listed. Threads and other questions are still answered in sentences. See [plugin/skills/operator/SKILL.md](../plugin/skills/operator/SKILL.md).
- `jig ask --waiting` carries recorded stage and parked questions in its JSON and text answers, so the waiting card can quote them from one read. A status card with no previous launch says so.
