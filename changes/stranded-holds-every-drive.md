---
release: patch
---

### Fixed

- A launch whose process nobody can show running, and that holds a drive
  past 30 minutes, is now raised to a person whatever the drive's class: a
  finished, running, silent, refused or parked drive's hold, and a merged
  pull request's, used to stay silent while it kept a launch slot of its
  account taken. The tick raises the need, its notice says the hold keeps
  the account's slot and that `jig dispatch clear` frees it, and
  `jig ask` names the hold instead of answering `waitsOn: none`. A merged
  pull request's hold counts from its merge, and a running drive's from the
  launch. The tick sees a merged pull request through the follow-up
  stage's listing, so it raises that hold where follow-ups are configured.
