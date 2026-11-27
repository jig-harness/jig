---
release: minor
---

The dispatcher's outcome log now records a need's life, and every record names the release that ran it.

### Added

- The outcome log gets a `need-opened` row when a need first appears on the line and a `need-closed` row when it has left, written whatever the notify stage did. A need absent from a single tick (a read that failed, a forge that did not answer) stays open: it closes only when it is absent from two ticks in a row, timed at the first, and its close row says how long it was open and how it left. The log's text copy and `jig dispatch log --jsonl` print the rows. **Consumer action:** none.
- Every tick receipt, launch record and outcome log row carries a `release` field, the plugin version that wrote it. A run counts under the release in effect when it was launched: its ended row names the launch record's release, not the release installed when it ended. Records written before the field read without it. The log table gets a `release` column for counting by release. **Consumer action:** none.
- `jig upgrade --scheduled` appends each upgrade that updated the plugin or failed to `~/.local/state/jig/upgrade/history.jsonl`, one line each. The upgrade never rewrites or prunes the file, so the releases a machine ran, and when each began, stay readable after the receipts that held them expire. **Consumer action:** none.
