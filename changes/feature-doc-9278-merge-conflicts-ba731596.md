---
release: minor
---

### Added

- [M11](../modules/M11-process-observability/README.md) registers conflict
  events and merged-pull-request conflict share. The `drive-pr` scoreboard
  combines replay and clone-local resolutions, states its coverage and
  withholds a verdict when unknown pull requests could change it.
- [M12](../modules/M12-parallel-agent-ergonomics/README.md) asks repositories
  to measure conflict hotspots and remove their causes or record a decision
  to keep them. The audit runs the replay as read-only evidence and scores
  whether the repository follows the practice.
