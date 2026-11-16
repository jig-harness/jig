---
release: minor
---

### Changed

- Deferred review findings enter the backlog in one open issue per pull
  request and issue type on every supported tracker. Later findings append
  to the same issue, with the highest priority and union of categories;
  native related links preserve the originating issue and epic without
  adding children to their scope. **Consumer action:** advised at
  instructions. Replace runbook rules that parent deferred findings to an
  epic with backlog batches and related links. Existing follow-ups are not
  backfilled. **Detect:** `text:Parent the follow-up`,
  `text:Findings deferred while the epic is live still go to the epic`.
- M9 and the audit now distinguish delivered epic scope from person-only
  tails, place those checks on one standing person-checks list at closure,
  and allow a native Epic issue type without a separate kind. Closure wiring
  for that list remains planned.
