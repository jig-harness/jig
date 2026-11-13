---
release: minor
---

### Added

- The dispatcher checks each account's tracker credential before it launches
  a follow-up or a pickup. Once per tick for each account and tracker, it
  reads the repository's tracker headless, in the repository's checkout and
  the environment a pass on that account runs in. An account the tracker
  refuses, or whose read gives no answer in time (an operating system
  keychain waiting for an approval, a lapsed connection), takes none of
  those launches: they go to another account or wait. The dashboard shows
  one need per account for the whole host, `tracker-unreachable`, act
  Authorize, naming every repository it holds and the tracker's answer,
  instead of a failed pass for every pull request. A rate limit, a server
  error, the network or a configuration that opens no tracker holds
  nothing: the stage's own handling of them applies. A later passing check
  clears the need and the launches start. `preflight` in the machine's
  dispatch file names the checks: `[tracker]` by default, and `[]` turns
  them off ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
