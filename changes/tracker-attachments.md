---
release: minor
---

### Added

- The tracker interface attaches a file to an issue on every adapter:
  `tracker.ts attach "<KEY>" --input <file>` attaches it and, with
  `replace`, then removes the older attachments of the same file name or
  title once the issue lists the new one; `tracker.ts attachments` lists an
  issue's attachments and `tracker.ts fetch-attachment` saves one. Linear
  and Jira upload the file to their own file store. GitHub Issues has no
  file upload, so the file's text goes in a marked comment when it fits one,
  or the comment links a copy the caller already hosts; anything else is
  refused (exit `3`) with nothing written
  ([EXTENDING.md](../plugin/EXTENDING.md#issue-tracker)).
- `reconcile_parent_status.ts` reads the tracker interface's answers for an
  epic and its children (`{ issue, parent, children, complete }`), so
  `do-item`'s parent-status reconciliation gives the same verdict on every
  adapter, on its native path too.

### Changed

- `/jig:decide` and `/jig:explain` attach their sheets through
  `tracker.ts attach` instead of Linear's tools, and say what happens when
  a tracker can only link a sheet or cannot hold it: the sheet stays a local
  file and the comment says so. The sheet renderers' `render` summary now
  carries the sheet's `path` and `replace: true`, and is what `attach`
  reads. `/jig:decide` regenerates a ruled sheet from the one `tracker.ts
  fetch-attachment` reads back.

### Removed

- `decision-sheet.ts stale-attachments`: `tracker.ts attach` removes the
  older sheet itself, and only once the issue lists the new one.
