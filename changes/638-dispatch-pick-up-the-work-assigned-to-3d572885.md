---
release: minor
---

### Added

- Hosts can serve named people through `serve:` in their dispatch machine file. Their trusted assignments and unassigned epic descendants join a ranked queue, with blocked work and human checkpoints shown with a reason; claims preserve the served person as assignee. Served forge logins also join pull-request adoption.

### Fixed

- The dispatcher record inventory now accurately describes pickup-read cache writes as independent upserts rather than one tick-wide transaction.
