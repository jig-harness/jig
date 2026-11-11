---
release: patch
---

### Fixed

- `jig dispatch` no longer reports every item a served person has in
  progress as a stalled pickup. A person moves their own work and epics to
  in progress too, so a served person's item is watched for a stall only
  while a pickup of this host holds its claim; the rest read as
  `claimed-by-person` and stay off the dashboard's needs. Items claimed
  through `dispatch.identity` are watched as before.
