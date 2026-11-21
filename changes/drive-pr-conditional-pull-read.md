---
release: minor
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
- **Breaking:** [`drive-exits.md`](../plugin/protocol/drive-exits.md), now
  version 2, lists `UNSUPPORTED_CLI` as a `driver-only` exit: `drive.ts`
  exits `2` when it refuses to start, and `drive-status.ts` no longer reports
  it as a state, since every `gh` serves the evaluation's REST read. Its
  `driveStatusExit` in
  [data/drive-exits.json](../plugin/protocol/data/drive-exits.json) is now
  `null`; `drive-status.ts`'s own argument errors still exit `2`, with no
  report. **Consumer action:** advised at instructions. A program that runs
  `drive-status.ts` itself reads its exit `2` as an argument error with no
  report, never as a state. **Detect:** `text:UNSUPPORTED_CLI`.
