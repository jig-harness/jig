---
release: minor
---

### Added

- `/jig:changelog` can convert a branch that edited the changelog or the version itself into one with a change note. `convert.ts` moves the branch's entries into a note, puts back the integration branch's open sections and version, sets a version placeholder the branch filled back to its text, and leaves the result uncommitted for review. A branch stacked on another converts against that branch with `--base`.
- `do-item` writes the change note before it opens the pull request and runs the branch check with the other gates; `drive-pr` and `resolve-review-comments` update the note in the round whose accepted fix changes what it says; `resolve-conflicts` converts a branch's changelog edits into a note before merging, so they cannot conflict. Each asks the changelog skill first, reading the configuration the integration branch holds rather than the branch's own, so a repository that did not set `changelog.file` is never asked for a note and a branch that predates its adoption still is.

### Changed

- A change note's file name keeps at most the first 64 characters of the branch's name before its eight digits, so a long branch name stays within what a file system allows.

### Fixed

- `/jig:changelog`'s status report answers with a release run still going before a newer one that ended, and reads only the release workflow's own runs, so other workflows' runs can no longer hide a release in progress. Its runs are listed back to the point past which none can still be going, split by when each was created rather than by its status, so newer runs that ended cannot hide one and a run whose status changes between listings is still seen; a listing `gh` may have cut short at its limit reads as unknown rather than as an answer.
