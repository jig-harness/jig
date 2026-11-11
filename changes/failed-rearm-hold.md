---
release: patch
---

### Fixed

- `jig dispatch` no longer re-arms a stopped drive at every tick when each
  re-arm fails before the drive moves its ledger. A re-arm that ended on a
  failing exit (other than a second driver's refusal or a usage-limit wall)
  is not started again while the pull request's head, its branch's head and
  the ledger's generation are the ones it launched at: the receipt shows the
  drive as needing a person, with why, and a person is notified once rather
  than at every tick. A change of either head or of the ledger lets the next
  tick re-arm it. The hold needs the heads recorded at the launch and the
  branch's head readable now; when either is missing, the next tick launches
  again.
- A drive whose pull request is behind its branch (the forge kept an older
  head after a push) now says so: its attach names the pull request's head
  and the branch's head and asks for the pull request to be closed and
  reopened, which makes the forge take the branch's head, and the
  dispatcher's notification names both commits and that recovery.
