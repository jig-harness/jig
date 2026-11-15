---
release: minor
---

### Added

- `JIG_GITHUB_INSTALLATION_ID` declares the GitHub App installation an
  installation token (`ghs_`) belongs to. Whatever issues the token sets
  it, since the token cannot name its own installation: every token of one
  installation, a replacement after expiry included, then shares one
  budget record and its hold.
- The cost ledger names, for each GitHub row, the quota owner whose record
  it spent and the window it spent: core, GraphQL, search, none or unknown,
  from the answer's rate-limit header, the `gh api` route, or a table of
  the subcommands Jig runs (`gh pr view` spends GraphQL points). The tick
  report and `jig budget` show spending per window, and a low-quota need
  says when its spending includes estimates or spending in a window the
  ledger could not name.

### Fixed

- The machine's GitHub budget is kept per quota owner, not per token.
  Several processes with different personal tokens of one user, or the
  `gh` stored login and a token of the same user, reserve against one
  balance, and a limit one of them meets holds the others. Each credential
  is asked who it is once (`gh api user`), and the answer is kept for every
  process: a week for a token, a day for a stored login, 15 minutes before
  a failed question is asked again. A credential whose owner cannot be
  established shares one record per host with every other such credential,
  which can only make them spend less. Records an earlier release kept per
  credential stay readable, and seed the owner's record with any active
  hold kept.
- A `gh api --paginate` read was charged one request however many pages
  it sent, so a long read could pass the dispatcher's floor. When its
  output is captured, the forge client now sends it a page at a time, each
  page admitted and charged as a request of its own; the read stops as
  `rate-limited` at the floor, keeps one deadline for all its pages and
  fails as `too-costly` past 100 pages. A paged read the client cannot
  page itself (streamed output, GraphQL with `--jq`) reserves 10 requests
  before it starts and is charged them as an estimate.
- `gh pr view` and the other GraphQL subcommands were counted against the
  core requests in the low-quota forecast; they now count against the
  GraphQL window, as estimates.
- The stored login's key names the account `hosts.yml` makes active, so
  switching accounts with `gh auth switch` no longer inherits the previous
  account's budget, and cached GitHub answers are kept per credential, so
  two tokens of one user never read each other's.
