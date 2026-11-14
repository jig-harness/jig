---
release: minor
---

### Changed

- The dispatcher's notices now go out through a notification channel, so a
  later release can add a team chat beside the Orca workspace comment. The
  Orca comment and unread mark are the `orca-card` channel, and what a
  person sees there does not change. Each channel keeps its own record of
  what it sent and backs off on its own, so a notice that one channel loses
  is tried again on that channel alone. The state database's `notices`
  table gains a `channel` column. Existing rows read as `orca-card`, and a
  plugin copy one release behind still reads and writes the table.
- A notice about a drive (parked, stopped, ready to merge) now also carries
  structured fields beside its text: the drive's address, the pull
  request's link, the commands its text names, and, for a park, each
  decision with its question, recommendation and options, with what each
  changes and costs. These fields appear in the tick's receipt; the text
  is unchanged.
