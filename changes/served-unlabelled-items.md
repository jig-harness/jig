---
release: minor
---

Served items that no repository label places are no longer started by every repository that shares their tracker team.

### Added

- `serve_defaults` in the host's dispatch machine file names, for each tracker team, the one repository that starts served items carrying none of the repository labels. The other repositories of the team leave such an item alone, and the launch-time recheck refuses it there. Documented in [CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file).

### Fixed

- A served item with no repository label was launched by every pickup repository that read its Linear or Jira team, each pass racing the others for the claim. Now only the team's default repository starts it; a team with no default has the item reported once as needing a repository label, and no pass starts. Items that carry a repository label still go only to that repository, and a GitHub repository reading its own issues is unaffected. A Linear or Jira repository that has `review.repo_label` and `review.taxonomy.repos` set now needs its team named in `serve_defaults` for its unlabelled served items to start; until then each is held with that reason in the Queue view.
