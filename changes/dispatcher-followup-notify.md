---
release: minor
---

### Added

- `jig dispatch` follows up a merge: with the `followup` stage enabled in the
  machine file, each pull request merged since the stage started gets one
  session running the repository's `dispatch.followup_command` on it, in its
  workspace. A hidden-marker comment on the merged pull request claims the
  follow-up before the session starts, and an earlier marker makes a later
  run stand down. A follow-up whose session failed, or whose marker names a
  launch record the machine no longer has, is notified once and never started
  again; deleting its marker makes it wanted again. The session is an
  interactive one, so with Orca, which cannot yet bind one to a chosen
  account, each follow-up is reported and nothing is posted or started, as a
  pickup is.
- `jig dispatch marker claim|check|done <PR>`: how a follow-up command a
  person runs by hand claims the merge with a marker of its own, checks before
  each act outside the pull request that no earlier marker appeared (exit
  `3` when one did), and marks its marker done once it succeeded.
- `jig dispatch` reaches a person: with the `notify` stage enabled, each stop
  only a person settles is notified once per cause, through the session
  runtime: a drive parked with a decision unanswered (carrying the drive's
  framed decision and how to answer it, `answer <key>: …` on the pull
  request, which the next tick re-arms on), a drive stopped on an exit only a
  person settles or with no exit, a failed follow-up, a stalled pickup, a
  double claim and a session waiting past `dispatch.blocked_after`. With Orca
  the message becomes the workspace's comment and the workspace is marked
  unread, which Orca's phone app shows; a target with no workspace that can
  take it goes to the repository's notices workspace
  (`jig-dispatch-notices`). A message counts as sent only once the comment,
  read back, carries it, and is appended rather than written over while the
  workspace is still unread.
- `drives.ts --report`, the morning report, lists what the dispatcher
  launched, refused and notified on the machine since the last report, beside
  the drives.

### Changed

- A drive's notification is planned whatever session runs in its pull
  request's workspace: telling a person never competes with a session.
