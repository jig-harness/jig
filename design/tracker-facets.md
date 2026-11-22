# Command store for tracker facets

The [Tracker facets chapter](../plugin/protocol/tracker-facets.md)
describes the stores available today. A repository may eventually need
a facet whose value neither a tracker field nor a label can represent.
This design is the [later command store work](plan.md#later).

## Later: the command store

A store kept by the repository's own command, for a facet no other store
can express (a value derived from two Jira fields, or kept in a service of
the repository's own), is not built until a repository names the facet it
needs it for. One command serves each facet. The adapter keeps the interface's other
operations in code. It must meet these
constraints:

- **Only the repository sets it, from its default branch.** It is one of
  the fields only a repository sets (`REPOSITORY_ONLY_FIELDS`), refused in
  the user file, an environment variable and an overlay file. A caller a
  timer starts (the dispatcher's tick, the weekly sweep) reads it from the
  default branch, as the dispatcher reads its own section, and runs the
  program that branch holds, never a copy in a working tree on another
  branch.
- **Its environment omits credentials.** It runs
  without the tracker and forge tokens the adapters read (`GH_TOKEN`,
  `GITHUB_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BEARER_TOKEN`,
  `JIRA_TOKEN_COMMAND`, `LINEAR_API_KEY`, `LINEAR_API_TOKEN`), so they stay out of its environment and its logs.
  It still runs as the same user, who can read the `gh` and `linear`
  logins and any file that user can, so what bounds it is the review of the
  default branch that names it.
- **Its output is checked and bounded.** One JSON object of at most 64 KiB,
  each value checked against the facet's closed list before any caller
  sees it; anything else fails the read.
- **It is batched.** One run per page of issues, runs one at a time, a
  deadline per run and per read, and a cache per dispatcher tick.
- **Read-only callers do not run it** (`jig ask`, the audit,
  `facetStores()`) unless the repository allows them to.
- **Its failures are redacted** to the same one bounded line as every
  store's, before they reach a receipt, a dashboard or a log.
- **Its changes have a history**: the store it reads records who changed a
  value, or the command reports it.
