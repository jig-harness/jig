---
release: patch
---

### Fixed

- A launch record of this machine whose process nobody can show running,
  and that holds a drive past 30 minutes, is now raised to a person
  whatever the drive's class. Before, the hold of a finished, silent,
  refused or parked drive, or of a merged pull request, stayed silent
  while it kept a launch slot of its account taken. The need says the
  hold keeps the account's slot and that `jig dispatch clear` frees it,
  and `jig ask` names the hold instead of answering `waitsOn: none`. A
  merged pull request's hold counts from its merge, and a running drive's
  from the launch. A drive whose driver may still run (a running, silent
  or unread ledger) is raised only once every process of the record is
  proved gone, so a failed process read never raises a working drive. The
  tick sees a merged pull request through the follow-up stage's listing,
  so it raises that hold where follow-ups are configured.
