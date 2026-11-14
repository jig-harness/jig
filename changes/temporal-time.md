---
release: minor
---

The plugin's scripts now read the clock, parse timestamps and do calendar
arithmetic with the Temporal API (Bun 1.4 and later, the version the plugin
already asks for) instead of `Date`.

### Changed

- Timestamps Jig writes keep their form: ISO 8601 in UTC to the millisecond.
- Timestamps Jig reads must be ISO 8601 (`Z` or an offset, a space for the
  `T`, a date alone, or a date-time with no offset, which is UTC). A record
  in another shape, such as a date written in words, now reads as invalid where
  `Date.parse` guessed at it.
- The dispatcher's weekly and off-hours rules take their calendar fields
  from a named time zone rather than hand-computed offsets.
