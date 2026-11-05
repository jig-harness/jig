---
release: minor
---

A signal the drive and the dispatcher share is kept in one place: the
dispatcher reads a drive's exit codes from drive-pr's own registry, a pull
request's review rounds are one record every review loop counts into, and a
mailbox stop can address one driver.

### Added

- A drive mailbox `stop` can name the driver it is for:
  `mailbox.ts send <PR> --kind directive --command stop --generation <n>`
  ends only the driver of that generation, at its next round boundary, and a
  later driver ignores it. Each driver prints its generation as it starts
  (`driver generation <n>`), and `drives.ts` lists it. A `stop` without
  `--generation` keeps its meaning: it stops every later driver in the
  working tree until `resume --target stop`, which now also withdraws every
  addressed stop.
- The driver appends an `ack` record to the mailbox outbox for each `stop`
  or `pause` it acted on, naming its generation, so a sender sees the
  directive took effect (`mailbox.ts outbox <PR>`).

### Changed

- `/jig:resolve-review-comments`'s `await-round.ts` counts review rounds in
  the drive's database (`~/.local/state/jig/drive-pr/state.sqlite`), one
  record per pull request and head that a drive counts into too, whether or
  not a drive runs, instead of the `resolve-review-rounds-<PR>` file and its
  `.head` file in the working tree's Git directory. On the first run after
  the upgrade the count starts again at the current head: rounds counted in
  the Git directory are not carried over, and those two files can be
  deleted. `current-round.ts` prints this one record, the round a drive's
  ledger carries; convergence settles a loop's rounds for its reflection
  prompt without lowering it. A drive's `--max-rounds` budget now counts the
  rounds a hand-driven loop counted on the same pull request in that clone.
  The skill installed without `/jig:drive-pr` beside it keeps no count.
- `drives.ts --stop <PR>` sends the live driver a mailbox `stop` addressed to
  its generation and marked to act at once; the driver cancels its active
  pass, acknowledges the stop and releases its locks, as before. A driver an
  earlier release started records no generation: `--stop` sends it nothing
  and forces its process tree after the 30-second grace.
- The dispatcher reads every exit of a drive by its name in drive-pr's
  terminal-state registry, so the two cannot disagree on a code. The outcome
  log's reasons for exits `7`, `12` and `15` name what happened (reviewer
  failed, worktree unclean, pass deadline) instead of repeating the code.
