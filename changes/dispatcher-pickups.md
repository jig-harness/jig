---
release: minor
---

### Added

- `do-item` claims the issue it picks up: `tracker.ts claim <key>` assigns
  it to the identity the tracker's credential acts as and moves it to
  `in_progress`, refuses an issue already in progress or assigned to anyone
  else (exit `3`, nothing written), and stands down when reading it back
  shows another claim landed first (exit `4`). `do-item` and `work-batch`
  stop on either instead of starting beside another session. The tracker
  interface gains `viewer`, `assignees` and `assign` on GitHub Issues,
  Linear and Jira.
- `jig dispatch` plans pickups with the stage's whole guard: an item a
  launch record or a running session holds is reported as running, one
  whose last session ended without claiming it waits until it leaves the
  dispatch states and comes back, an item more than one running session
  joins to is reported as a double claim, a claimed item idle past
  `dispatch.stalled_after` is reported as a stalled pickup and never
  relaunched, and a session it started that waits past
  `dispatch.blocked_after` is reported (both `30m` by default; see
  [CONFIGURATION.md](../plugin/CONFIGURATION.md#dispatch)).
- The machine file's `pickup` stage starts a `do-item` session per pickup,
  once, where the session runtime binds the session to the account it
  bills: the fresh read just before the launch, admission and the identity
  check, a workspace on the item's own branch with its issue linked, the
  route's model and effort, and a launch record holding its slot while the
  agent works or waits. The session records how it ended with
  `jig dispatch result <record> <token> done|failed`. Orca cannot bind an
  agent launch to a chosen account yet, so with Orca each pickup is
  reported with that reason and nothing is started
  ([the dispatcher](../plugin/README.md#the-dispatcher)).

### Changed

- A dispatch tick opens at most two workspaces, the opens its timer's
  deadline covers; a launch that needs another waits for the next tick.
- An agent Orca reports as `blocked` (on a permission prompt) now holds its
  stage, as a working or waiting one does.
