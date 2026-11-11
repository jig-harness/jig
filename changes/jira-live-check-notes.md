---
release: patch
---

### Changed

- The Jira adapter's documentation, after a run against a live Jira Cloud site: `JIRA_BEARER_TOKEN` and `JIRA_TOKEN_COMMAND` take an API token with scopes as well as an OAuth access token, so a credential broker can hand out scoped tokens; `issue_tracker.jira.api_base` says that the `tenant_info` address is not part of Atlassian's supported API and that an OAuth app reads the cloud id from `oauth/token/accessible-resources`; and `issue_tracker.jira.link_types` says that a link type whose outward side means "has to be done before" reads as `Blocks` does and takes no `inverted`.
