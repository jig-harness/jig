---
release: minor
---

### Added

- A dispatcher tick's receipt records what started it (`startedBy`): `timer`, `wake` for Jig's wake waiter, `command` for the `jig` command, or the name another launcher sets in the new `JIG_STARTED_BY` variable ([CONFIGURATION.md](../plugin/CONFIGURATION.md#environment-variables)). The launcher passes it to every job.
- `jig doctor` checks the dispatcher's tracker credential (`dispatch:tracker-credential`): it fails when ticks of the last 24 hours ran with no Linear key, naming each repository, how many ticks and which callers had no key, and what to set.

### Fixed

- A process with no Linear key whose `linear` client is not logged in (or not installed) now learns it at its first call and asks Linear nothing more: every call fails as `unauthorized` with "no Linear key configured" and the variables it looked for. A dispatcher tick in that state names the missing key once on its receipt (`noCredential`) and its log instead of on every read, card and account; the issue preflight probes and holds no account for that tracker; no repository's turn fails for it; each repository the tracker serves keeps its tracker part of the line (its item cards and needs) from the last reading that had a credential, marked with that reading's time and the reason (`trackerKept`); and the tick exits 9, the `unauthorized` class's status, instead of 1.
- `jig budget` no longer shows calls made with no credential as spending of a credential that keeps failing: they are kept under no credential, with no requests, and listed apart under "no Linear key configured" with their callers (`noCredential` in `--json`). A logged-in `linear` client's calls are labelled as the client's own login (`credentialLabel`) rather than a bare hash.
