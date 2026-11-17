---
release: minor
---

### Added

- A tracker footprint record and interface for predicted repository paths
  and change areas, with trusted comment selection on GitHub, Linear and
  Jira. Bounded, governed reads reuse unchanged predictions, batch comment
  requests where supported and retain an aged reading when a tracker does
  not answer.
