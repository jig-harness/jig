---
release: minor
---

### Added

- The plugin ships the first chapter of the [Jig Protocol](../GLOSSARY.md),
  [protocol/drive-exits.md](../plugin/protocol/drive-exits.md): every end
  state and exit code of a drive, with what each one means, for a program
  that reads how a drive ended without reading Jig's code, and the same
  values as JSON in `protocol/data/drive-exits.json`. The chapter is
  generated from drive-pr's own table of states, and Jig's build fails when
  the two disagree. `guarded-push.ts`'s exit `17` (a `hold-push` directive
  in force) is now part of that table, so no other exit can take the code.
  **Consumer action:** none.
