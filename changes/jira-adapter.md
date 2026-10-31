---
release: minor
---

The skills can work on a Jira Cloud project as their issue tracker, beside
GitHub Issues and Linear.

### Added

- A Jira Cloud tracker adapter, chosen with `issue_tracker.adapter: jira`:
  `do-item`, `drive-pr`, `file-issue`, `work-batch`, `reflect`, the
  dispatcher and the audit's reachability check work on the issues of one
  Jira project. `issue_tracker.team` names the project key (`ENG` for
  `ENG-123`). How states, priorities, issue types, fix versions, labels,
  parents and issue links map onto Jig's tracker interface is in
  [plugin/EXTENDING.md](../plugin/EXTENDING.md#issue-tracker).
- Its credentials, `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment: an
  Atlassian account's email address and an API token made for it.
- The `issue_tracker.jira` configuration section, whose unknown fields are
  refused: `site`, the Jira Cloud site's `https://` address (required; an
  `*.atlassian.net` host, or one `JIRA_ALLOWED_HOSTS` in the environment
  names, so a repository's configuration cannot send the credential
  elsewhere);
  `issue_type` (default `Task`) and `subtask_type` (default the project's
  one sub-task type), the types new issues get; and `priorities`,
  `resolutions` and `link_types`, which name the Jira priorities,
  resolutions and issue link types Jig's priorities, closed states and
  relations map to
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#issue_tracker)).
- On Jira, `issue_tracker.states` names are matched to status names ignoring
  case, a status no name matches is read by its status category, and
  `done`, `canceled` and `duplicate` may share one status when their
  resolutions differ.
- `dispatch.identity` on Jira: an Atlassian account id, or an email address
  or display name that matches exactly one user. An assignment starts a
  pickup only when a person's Atlassian account made it, not a guest, that
  can be assigned issues in the project.
