---
release: patch
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
- A drive ledger that names a managed user as a parked question's person is
  refused by a host still running an earlier release, so upgrade every host
  that reads a shared ledger before a managed user is routed a parked
  question.
