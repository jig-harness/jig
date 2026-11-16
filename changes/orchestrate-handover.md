---
release: minor
---

### Added

- `orchestrate` now hands a long coordination over to a fresh session before
  its context fills. At a natural pause it suggests the handover to the
  person; once they agree it brings the durable record up to date (state,
  dated decisions, what waits on the person, owed acts, cautions and a first
  act for the successor), starts the successor in the surface the person
  works in with a short directive pointing at the record, or gives the
  person the exact command where the host cannot start one, confirms the
  successor is running and then stops acting
  ([procedure](../plugin/skills/orchestrate/SKILL.md)).
