---
release: minor
---

### Fixed

- SQLite state records each migration's identity and refuses conflicting
  histories at the same version. Legacy databases are structurally checked
  before a baseline is recorded, so a missing dispatch result column is
  reported before a result write; existing divergent state still needs an
  operator's repair.

### Changed

- **Breaking:** development checkouts refuse databases in the operating-system
  user's live Jig state directory. Run an installed release for live operations,
  or use an isolated home or explicit database path for development. A legacy
  database newer than a reader must first be opened by a plugin that knows its
  full schema before additive compatibility is available.
