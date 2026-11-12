---
release: minor
---

### Added

- **Breaking:** A stopped drive is re-armed by the dispatcher, not by hand.
  **Consumer action:** required at instructions, machine. Remove the manual
  restart step from runbooks and point the plugin source at the current
  release. **Detect:** `text:restart the drive`, `plugin-source:old`.
- A new setting keeps the dashboard's labels.
  **Consumer action:** advised at configuration. Set `dispatch.labels.enabled`
  to keep them. **Detect:** `config:!dispatch.labels`, `config:review.bots`,
  `file:.github/workflows/*.yml`, `plugin-source:project-scope`
- A clearer message for a malformed note. **Consumer action:** none.
- The check names the note it read. **Consumer action:** none

### Changed

- The upgrade picks the newest source. **Consumer action:** advised at
  machine. Upgrade the plugin when it is convenient.
- An earlier advice was wrong. **Consumer action:** retracts 0.157.0#3fa9c2b1.
- Another advice was wrong. **Consumer action:** retracts `0.158.1#0a1b2c3d`
- A `**Consumer action:**` written in a code span is text, not a declaration.
