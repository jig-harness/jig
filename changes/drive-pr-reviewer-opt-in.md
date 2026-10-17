---
release: minor
---

`/jig:drive-pr` no longer assumes every repository has an AI reviewer.

### Changed

- **Breaking**: `/jig:drive-pr` waits for an AI reviewer only where the
  repository names one, with `review.reviewer_app` or
  `review.reviewer_check_pattern` in `.config/jig.yaml` (or the
  `DRIVE_PR_REVIEWER_APP` and `DRIVE_PR_REVIEWER_CHECK` overrides). Before, a
  repository that set neither was held in `AWAITING_REVIEWER` until the
  timeout, looking for a check named `AI review`. Now it converges on zero
  unresolved threads, zero unaddressed summary findings and green CI, and a
  check that only looks like a reviewer's counts as an ordinary check. A
  repository whose AI reviewer relied on the built-in check name must set
  `review.reviewer_app` (its GitHub App slug) to keep waiting for it;
  `review.bots` alone no longer makes the drive expect one.
