---
release: minor
---

### Added

- `drive.max_rounds` sets a repository's default round budget for `drive-pr`
  (default `10`, as before). `--max-rounds` still overrides it for one run.
  Jig's own configuration sets it to 30.

### Changed

- Integer settings accept only whole numbers that can be represented exactly
  (up to 2⁵³ − 1). This applies to `drive.max_rounds`, `--max-rounds`,
  `pull_requests.size_budget`, `pull_requests.max_stack_depth`,
  `pull_requests.mark_ready`, and the audit's configuration check. A larger
  value used to be read as a rounded number and is now refused.
  **Breaking** for a `.config/jig.yaml` that sets one of these
  `pull_requests` values above 2⁵³ − 1: `drive-pr` reads the whole policy
  when it starts and stops with exit 1, and `do-item`'s pull-request plan
  refuses it too. Before upgrading, lower the value to 9007199254740991 or
  less, or delete it to use the default.

