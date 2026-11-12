---
release: patch
---

### Fixed

- `jig dispatch` no longer reports every item a served person has in
  progress as a stalled pickup. A person moves their own work and epics to
  in progress too, so a served person's item is watched for a stall only
  when a pickup of this host claimed it; the rest read as
  `claimed-by-person` and stay off the dashboard's needs. A dispatched
  pickup's `tracker.ts claim` notes the claim on the pickup's launch record
  as it lands, so a pickup that claims and ends between two ticks is still
  watched. Items claimed
  through `dispatch.identity` are watched as before.
