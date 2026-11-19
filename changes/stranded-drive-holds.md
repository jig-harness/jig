---
release: patch
---

### Fixed

- A drive held by a launch whose process nobody can show running no longer reads as waiting on nothing. `jig ask` names the hold, why its process is unknown and how long it has held the drive, and past 30 minutes the dispatcher raises a need for it, where a person can clear this machine's launch record once every process of it has been judged and none runs.
