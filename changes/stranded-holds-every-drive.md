---
release: patch
---

### Fixed

- A launch record of this machine that holds a drive past 30 minutes,
  every process of which is proved gone without an exit recorded, is now
  raised to a person whatever the drive's class. Before, the hold of a
  finished, running, silent, refused or parked drive, or of a merged pull
  request, stayed silent while it kept a launch slot of its account taken.
  The need says the hold keeps the account's slot and that
  `jig dispatch clear` frees it, and `jig ask` names the hold instead of
  answering `waitsOn: none`. A merged pull request's hold counts from its
  merge, and a running drive's from the launch. A hold whose processes
  still run, or cannot be judged, is not raised for those drives. The tick
  sees a merged pull request through the follow-up stage's listing, so it
  raises that hold where follow-ups are configured.
