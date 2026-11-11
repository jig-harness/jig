---
release: minor
---

### Added

- `pull_requests.base_rules` chooses a pull request's base from the item's
  labels, for a product whose fixes land on a maintained release line: the
  first rule one of whose labels the item carries names the base, and the
  integration branch is the fallback. `pr-plan.ts branch` prints the base
  to cut the branch from, `pr-plan.ts open` opens against it, names the rule
  that chose it and refuses a base the remote does not have, and do-item
  cuts the branch from it. A label may come from a Jira field through
  `issue_tracker.jira.field_labels`.
- `pull_requests.title_format: pattern` with `pull_requests.title_pattern`
  (`{key}` and `{summary}`, such as `{key}: {summary}`) for a team whose
  tracker key leads every title: `pr-plan.ts open` prints the title rendered
  for the issue, and the audit checks the pattern against the titles of the
  last thirty merged pull requests.
- `pull_requests.commit_prefix` (such as `"{key}: "`, the key read from the
  branch name) for an organisation that refuses commits without a tracker
  key on its protected branches. `drive-pr/scripts/commit-prefix.ts` rewords
  each unpushed commit that lacks it, merge commits included, and reports a
  pushed one; drive-pr, fix-ci, resolve-conflicts and do-item run it before
  they push.
- The audit warns of a base `pull_requests.base_rules` names that the
  repository does not have.

### Changed

- `pr-plan.ts branch` prints the base on a second line
  (`base: <branch> (<source>)`), and `--json` adds `base` and `baseSource`;
  a caller that read its whole output as the branch name reads the first
  line. With `pull_requests.base_rules` declared, `branch` and `open` need
  `--issue-json`.
