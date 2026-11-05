---
release: minor
---

### Added

- `jig ask <address>` says where one station of the execution line stands on
  one piece of work, from the records alone: who holds it, its state, what it
  waits on, its last outcome, and every record it consulted or could not
  read. An address is `station@owner/name#key` for the stations `pickup`,
  `drive` and `followup` (`drive@owner/name#456`); the repository may be its
  short name where the machine's dispatch file lists one of that name, or
  left out inside its checkout. `--json` prints the answer as one versioned
  object, `--thread` adds the address's requests, questions, answers,
  launches and outcomes (`--since`, `--all`), and `--waiting` lists every
  address that waits on a person from the dispatcher's newest tick, with no
  forge or tracker call. It writes nothing; it exits `1` when the key names
  nothing and `2` on a malformed address or an unknown station. See
  [plugin/README.md § Asking a station where it stands](../plugin/README.md#asking-a-station-where-it-stands).
- The dispatcher's outcome log keeps the piece of work each row is about in
  an indexed column, added to an existing database by an additive
  migration, so one pull request's or item's rows are one lookup.
