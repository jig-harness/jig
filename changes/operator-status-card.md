---
release: patch
---

### Changed

- `/jig:operator` answers a status question (where a pull request, a tracker item or a follow-up stands) as the same card every time: `jig ask`'s own answer as it printed it, then four lines saying where the work stands, what it waits on, what you can do (with the drive doctor's recovery command quoted for you to run) and what the answer could not read. Threads and other questions are still answered in sentences. See [plugin/skills/operator/SKILL.md](../plugin/skills/operator/SKILL.md).
