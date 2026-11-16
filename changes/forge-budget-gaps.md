---
release: minor
---

### Added

- `jig budget` and the low-quota need show GitHub spending that no counted
  call explains. When the `rate_limit` endpoint reports a balance below what
  the machine's budget record had counted for the same window, the
  difference is recorded on an `(unattributed)` row of the cost ledger, in
  requests for the core limit and points for GraphQL, never on an operation.
  `jig budget` prints it as unattributed, and its `--json` groups carry
  `unattributed: true`.

### Fixed

- A GitHub GraphQL request sent over HTTPS (with `JIG_GITHUB_GRAPHQL_URL`
  set: the GitHub tracker adapter and the GitHub reflection store) now keeps
  to the machine's budget record as a `gh` run with the same token does. It
  is paced and admitted before it is sent, reserving a GraphQL point. It
  records the balance its answer reports. A refusal it meets holds the token
  for every process, and a refusal a `gh` run met holds it.
  `JIG_FORGE_BUDGET=off` leaves these requests out as well.
