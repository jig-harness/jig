---
release: patch
---

### Changed

- `drive-pr`'s status evaluation reads the pull request (state, draft, head
  and base, mergeability and merge state) with one conditional REST read of
  the pull document instead of `gh pr view`, for its opening snapshot and for
  the recheck before a terminal verdict. An unchanged pull request answers
  `304`, which costs nothing from the account's rate limit. A failed read, or
  a kept reading that is incomplete, is followed by one full read (except after a rate limit, an auth failure or a
  missing pull request, which a second request cannot clear), and is
  never taken for an unchanged pull request. Mergeability GitHub has not
  finished computing still reads as unknown. `drive-status.ts` resolves a
  pull request given as a URL or branch to its number once, before it
  evaluates, and refuses a URL naming another repository.
- The status evaluation no longer reports `UNSUPPORTED_CLI` for a `gh` too
  old to report mergeability: every `gh` serves the REST read. The state and
  its exit `2` stay, for a drive that refuses to start.
