---
release: minor
---

The dispatcher keeps its state in one SQLite database.

### Changed

- **The dispatcher's state is one database.** What `jig dispatch` keeps
  between runs (the launch records, the records that keep a notification
  or a nudge from going twice, the waiting and drift observations, each
  follow-up's outcome, the stall clocks and the outcome log) is now
  `~/.local/state/jig/dispatch/state.sqlite`, opened with Bun's built-in
  SQLite, one table each. An outcome row is written in the same
  transaction as what it records, so a run that stops between the two
  leaves nothing to repair. The receipts and the account walls stay files.
  The first run on this version creates the database and leaves the
  `launches/`, `notices/`, `nudges/`, `idle/` and `followups/` folders of
  an earlier version unread; delete them once the new version runs. The
  month files an earlier version wrote stay, and new rows are added to
  them. A database written by a newer plugin is refused, with its version
  named.
- **The dashboard queries the log.** `jig dispatch dashboard` filters in
  SQL over the outcome log's table, reads the rows and their counts in one
  read transaction, and reads while a run writes.

### Added

- **`jig dispatch log [--since <date>] [--jsonl]`** prints the outcome log
  as text, or as JSON lines. Every run also adds the rows it wrote to the
  month files (`log-<year>-<month>.jsonl`), the copy that outlives any
  change to the database.
- **`jig dispatch clear <record>`** removes a launch record only a person
  can settle (one claimed on another host or before a reboot, a pending
  one whose launch cannot be retried, or one that does not read), which
  until now meant removing its files. It refuses a record whose session
  is still running.
