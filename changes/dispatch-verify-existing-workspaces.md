---
release: patch
---

### Fixed

- `jig dispatch` now proves a workspace it did not open itself before a
  drive runs in it: the workspace joined to the pull request, a stopped
  drive's tree it recovers, and the recorded workspace of a launch it
  replays must each be a checkout of the repository's clone, with its origin
  the pull request's head repository and its commit on the head's line of
  history. A stale checkout of an earlier branch of the same name, or one
  whose origin changed, is refused with its reason and nothing runs in it;
  the proof changes no work in the workspace.
