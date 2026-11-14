---
release: minor
---

### Added

- The Jig Protocol has stable chapters on the drive mailbox and on the
  pull-request labels, each with its data file in
  `plugin/protocol/data/`. [The drive mailbox](../plugin/protocol/mailbox.md):
  the messages and directives a person or a tool may write to a running
  drive and the acknowledgements it writes back, with every field of both
  files' lines. [The pull-request labels](../plugin/protocol/pr-labels.md):
  the state labels a drive, a follow-up and the dispatcher's tick keep
  current and the command labels a person adds. Both are generated from the
  tables the mailbox's parser and the label projection read, so a program
  that writes to a drive or filters by its labels reads the values the code
  holds.
- A stable chapter on
  [the commands a repository supplies](../plugin/protocol/repo-commands.md)
  lists every setting whose value is a command Jig runs: who runs it, what
  it is given and answers with, whether it runs under the command store's
  rules or through a shell, its deadline and what changes it, and the exits
  besides 0 its caller reads, with its data file. It is generated from one
  table in `plugin/shared/repo-commands.ts`, which the preflight, the CI-log
  read, code-stats' classify command, the changelog's `after_version` and
  the reflection store's client take their deadlines and exits from.
