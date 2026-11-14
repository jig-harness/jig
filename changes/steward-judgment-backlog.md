---
release: minor
---

### Changed

- The steward now starts when a repository's judgment backlog holds work no
  earlier pass judged: a stalled pickup or failed follow-up with no running
  session, a stopped drive a re-arm could resolve, an ended pass that
  recommends a resume, a queued item missing a facet, or a need nothing has
  framed. It starts at once, within the host's three passes an hour, and an
  empty or already judged backlog starts no pass; the receipt and the
  dashboard say which. `steward.every` is still read and no longer changes
  anything. The digest lists framed needs apart from the needs the steward
  may frame, and a `need` record for a framed one is refused.
