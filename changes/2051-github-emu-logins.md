---
release: minor
---

### Fixed

- [Enterprise Managed User](../GLOSSARY.md) logins, which join a handle and
  the enterprise's short code with an underscore (`mona_acme`), are now taken
  where Jig reads a GitHub login: a host's `serve[].forge`, the drive's and
  `jig ask`'s and `jig send`'s signed-in login, the outbound budget's
  credential owner, the reviewers a change area or
  `pull_requests.reviewers_from_issue` requests, `dispatch.person`, a parked
  question's person and the dispatch dashboard's token owners. Before, each
  refused such a login. A repository owned by a managed user is not yet
  supported by the readers of a repository's owner (the address parser, the
  GitHub tracker settings and the hub's partitions). A `[bot]` login is still
  taken only where it was before. One check in `plugin/shared/forge-logins.ts`
  holds the rule for all of them: a short code of three to eight letters or
  digits, and no other underscore.
- **Breaking:** The [hidden comment markers](../plugin/protocol/comment-markers.md)
  protocol is now version 2. Its drive-ledger schema constrains a parked
  question's person to a GitHub login, including an Enterprise Managed User
  login. Upgrade every host that reads a shared ledger before a managed user
  is routed a parked question; earlier hosts refuse the version 3 ledger.
  **Consumer action:** required at machine. Upgrade every host that reads
  shared drive ledgers.
