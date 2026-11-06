---
release: minor
---

`jig send` tells a station of the line what to do, by writing the one record its reader already acts on.

### Added

- `jig send <address> <verb>` writes a request as a record the line already reads, and exits: `assign` (a tracker item assigned to the factory identity in a dispatch state), `drive`, `hold` and `release` (the dispatch command labels), `answer <key> <text>` (a comment the re-arm reads as your verdict), and `pause`, `resume`, `stop` and `hold-push` (a directive in the mailbox of the working tree that holds the drive on this machine). It reads the address first and refuses a request the station cannot take, such as a `drive` on a pull request with a ledger, an answer to a key that is not parked or is already answered, or a second `hold`; it prints the repository, the login it writes as, the record and its reader before it writes; `--dry-run` writes nothing and `--as <login>` refuses another signed-in login. See [plugin/README.md § Telling a station what to do](../plugin/README.md#telling-a-station-what-to-do).
- A session the line started carries `JIG_LAUNCH`, its launch record (set by the dispatcher's wrapper) or its driver (set by the drive for its passes), and `jig send` refuses it the commands that are a person's.
- The machine's dispatch file takes `send: false`, which refuses every `jig send` from that machine ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
- The tracker interface names the user an identity names (`user`), on GitHub Issues, Linear and Jira.

### Changed

- The re-arm, the dispatcher and `jig ask` read an answer comment `jig send` wrote as a person's answer: its record envelope is the one hidden marker an answer may carry, and the drive's passes are handed the answer line without it.
