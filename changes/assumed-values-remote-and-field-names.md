---
release: minor
---

### Added

- `repository.remote` names the git remote the delivery skills push to and fetch from, `origin` by default ([CONFIGURATION.md](../plugin/CONFIGURATION.md#repository)). `drive-pr` fetches the pull request's base from it, diffs against `<remote>/<base>`, derives the integration branch from its `HEAD`, pushes through it, and refuses when its addresses do not name the pull request's repository; `do-item`'s `pr-plan.ts open` measures against it and prints it (`remote:`); `fix-ci`'s `probe-base.ts` uses it when `--remote` is not given; `resolve-conflicts` and `work-batch` fetch and merge through it; the GitHub Issues adapter derives its repository from it. A clone whose remote is called `upstream`, or a fork setup where `origin` is the fork, sets it once, in the repository's file or a person's user file. The name may hold ASCII letters, digits, `.`, `_`, `-` and `/` and must make a valid ref prefix; any other value, `null` included, is an error naming where it was set.

### Changed

- The review-triage file's `severity_mapping.<severity>.linear_priority` is now `priority`, the tracker interface's name; `linear_priority` is accepted as an alias, and a row may not set both.
- `fractal-metrics.ts --skip-linear` is now `--skip-tracker`; `--skip-linear` is accepted as an alias.
