---
release: minor
---

### Added

- The Jig Protocol has two more stable chapters, each with its data file in
  `plugin/protocol/data/`: [the drive mailbox](plugin/protocol/mailbox.md),
  the messages and directives a person or a tool may write to a running
  drive and the acknowledgements it writes back, with every field of both
  files' lines; and [the pull-request labels](plugin/protocol/pr-labels.md),
  the state labels a drive, a follow-up and the dispatcher's tick keep
  current and the command labels a person adds. Both are generated from the
  tables the mailbox's parser and the label projection read, so a program
  that writes to a drive or filters by its labels reads the values the code
  holds.
