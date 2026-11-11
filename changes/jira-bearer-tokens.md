---
release: minor
---

### Added

- The Jira adapter signs in with more than an account's email and API
  token. `JIRA_BEARER_TOKEN` sends an OAuth access token as
  `Authorization: Bearer`, and `JIRA_TOKEN_COMMAND` names a command that
  prints one, as `gh auth token` does, so a credential broker or vault holds
  the token and the environment holds only the command: the adapter runs it
  once per process under a deadline, runs it once more when Jira answers
  401, and names the variable when it fails. The first set wins:
  `JIRA_BEARER_TOKEN`, then `JIRA_TOKEN_COMMAND`, then `JIRA_EMAIL` with
  `JIRA_API_TOKEN`
  ([environment variables](../plugin/CONFIGURATION.md#environment-variables)).
- `issue_tracker.jira.api_base` sends the Jira adapter's requests through
  Atlassian's API gateway, `https://api.atlassian.com/ex/jira/<cloud id>`,
  which OAuth access tokens and API tokens with scopes require; a token with
  scopes goes in `JIRA_API_TOKEN` beside `JIRA_EMAIL`. Only that address
  shape is accepted, redirects are still never followed, and `site` still
  builds every issue's link
  ([`issue_tracker`](../plugin/CONFIGURATION.md#issue_tracker)).
