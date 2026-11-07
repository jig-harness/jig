---
release: minor
---

### Added

- Parked questions name the person they wait on: the question's change-area owner, else `dispatch.person`, else the pull request's author. Notifications and `jig ask` carry that person, and `jig ask --waiting --person <login>` filters the line by named recipients without changing who may answer.
