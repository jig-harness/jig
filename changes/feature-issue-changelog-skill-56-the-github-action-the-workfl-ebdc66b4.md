---
release: minor
---

### Added

- The `changelog` skill runs in CI: a GitHub Action
  (`plugin/skills/changelog`, with `command: check`, `release` or `tag`) and
  a workflow template, `templates/github/changelog.yml`, that checks every
  pull request, releases on every push to the integration branch and tags
  each version. The release either pushes straight onto the integration
  branch as a GitHub App the branch's rules let past (`changelog.release.push:
  direct`) or opens a release pull request a person merges (`pull-request`).
  The release step and `after_version` run in a job that holds no key; the
  job that pushes runs nothing from the repository. The action starts Bun
  outside the checkout, so a repository's `bunfig.toml`, `.env` or
  `tsconfig.json` cannot change what it runs.
- Versions are tagged only once the commit that released them has passed its
  required checks. `tag.ts` prints which versions can be tagged now, re-runs a
  cancelled check once with `--rerun`, and leaves a commit whose checks failed
  untagged. Only versions newer than the newest release tag on `origin` are
  owed a tag (with none, only the newest), so an untagged history is never
  tagged on adoption; `status.ts` now lists the versions still waiting for their tag and
  exits 1 for a failed one.
- `release-access.ts` checks that the release App can reach the integration
  branch in the configured mode while force pushes and deletion stay blocked
  for it, reading every ruleset and the classic branch protection together.
- `/jig:changelog setup` walks a person through turning the skill on, one
  checked step at a time: the configuration and the changelog (from a new
  Keep a Changelog or Common Changelog template), the GitHub App from a
  prefilled App manifest, its environment, the branch rules, the workflow and
  the conversion of open pull requests. It changes no setting itself.
- The branch check passes a release pull request when re-running the release
  step on its merge base gives exactly its change; `check.ts --head-ref`
  names its branch where the checkout does not.

### Changed

- `ci.required_checks` also sets the checks a releasing commit must pass
  before its tag, read from the integration branch's own `.config/jig.yaml`.
  Name only checks that run on the integration branch.
- `status.ts` reads the last release run of the workflow named `release` or
  `changelog` (the template's name), and counts only its push and manual runs,
  so a tag or branch-check run of the same workflow cannot hide a failed
  release.
- `release.ts --json` also prints the changelog's path and the
  `changelog.release` settings.
- Jig's own releases run on the skill's action, and a release is tagged once
  `gates` passes on its release commit rather than in the push that made it.
