---
release: patch
---

### Fixed

- drive-pr: a required check whose workflow never runs on the pull request's
  head (an event or path filter excludes it, or the workflow failed to start)
  no longer keeps the drive waiting on `CI_HOLD_WAIT` until it stalls. Once no
  workflow run on the head is still to finish and 15 minutes have passed since
  the head's push, `ci-hold.ts ensure` parks `missing-required-run` for a
  person, naming each such check and the workflow whose job reports it
  (`unknown` when the head's workflow files name none, or several), and the
  drive stops `HITL_PARKED`. A check whose run is queued or in progress still
  waits. A round whose own commits change `.github/workflows/` pushes without
  the hold, so a repair it carries can start the check.
- drive-pr: a stall whose passes all ended `finish-round.ts` on the same state
  names that state and its reason in the stop and its closing report, and
  takes its cause from it (`environment` for `CI_HOLD_WAIT`) instead of
  `unknown`.
