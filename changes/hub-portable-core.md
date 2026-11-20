---
release: minor
---

### Added

- The hub's portable core (`plugin/hub/core/`): the five ports through which
  the hub reaches its platform (storage, serving, scheduling, outbound calls
  and observability), each method returning an `Outcome`, and `runUnit`, the
  one defect boundary around a unit of work, which hands every port call the
  unit's deadline and its single `AbortSignal`. Nothing serves yet: the
  storage and scheduling implementations and the process adapter follow.
- `jig hub` is a command; for now it prints its help.
- A GitHub transport over `fetch` (`plugin/shared/outbound/github-fetch.ts`),
  beside the `gh` transport the dispatcher and the skills keep using. It
  follows the outbound calls' obligations: it asks the shared budget, bounds
  each call by its deadline, records what it cost, fails as one of the closed
  failure classes, and charges nothing for a conditional request answered
  "not modified". Nothing calls it yet.
- The cost ledger records which repository a call was for, in a table beside
  the hourly rows, so rows written before this release read unchanged.
  `jig budget` shows the spend by repository (`--json` adds a `repositories`
  array); spend that names no repository is grouped as `(no repository)`.

### Changed

- The outbound library's portable parts (the failure classes, retry,
  paging, the conditional request and the budget's arithmetic) are split from
  the parts that open the machine's budget database or run `gh`. The
  library's callers are unchanged and behave as before.
