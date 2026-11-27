---
release: minor
---

The dispatch dashboard serves a scoreboard by release and the live checks.

### Added

- `GET /scoreboard` gives six numbers for each release that ran something in the last 7 or 30 days: merged pull requests, answers per merge, median need age, session-hours not converged, idle slot-hours and median rounds. A record counts under the release it names; records that name none count under `null`. It also names an end cause that no run had in the 14 days before, once three runs under one release ended with it.
- `GET /checks` serves the live-check report, and answers `checks-unavailable` while this release has none.
- Both only read, and answer under the dashboard's token and host checks.
