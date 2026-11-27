---
release: patch
---

### Fixed

- GitHub Enterprise Managed User logins, which join a handle and the
  enterprise's short code with an underscore (`mona_acme`), are now taken
  wherever Jig reads a GitHub login: a host's `serve[].forge`, the drive's
  and `jig ask`'s and `jig send`'s signed-in login, the outbound budget's
  credential owner, the reviewers a change area or `pull_requests.reviewers_from_issue` requests, `dispatch.person`, a parked
  question's person and the dispatch dashboard's token owners. Before, each
  refused such a login, so an Enterprise Managed User could not be served,
  answer through `jig ask` or `jig send`, be requested as a reviewer or be
  routed a parked question, and the budget fell back to its unverified
  bucket. One check in `plugin/shared/forge-logins.ts` now holds the rule
  for all of them; a `[bot]` login is still taken only where it was before.
  The drive ledger's protocol schema no longer spells the login pattern out
  for `parked.person`; the drive still checks it when it reads the ledger.
