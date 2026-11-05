---
release: minor
---

### Added

- **`jig dispatch line --json`** prints what the newest tick found as one JSON document: the answer the dashboard's `GET /state` gives for the same state database, from the same read, so a program beside the dispatcher (an editor's plugin, a status bar) reads the line without opening the database. Its `line` is versioned by its own `version` field. It takes no lock and never creates the database: with no database or no line yet it prints the answer with `line` set to `null` and exits 0; a line that cannot be read exits 1 with one line on standard error ([plugin/README.md](../plugin/README.md#the-dispatcher)).
