---
release: minor
---

### Added

- The dispatcher weighs each pickup it plans against the work in flight and
  says why one waits, without changing what it starts. Every open pull
  request counts by its changed files, and every pickup with no pull request
  yet by its footprint record, read through the tracker at most 20 items a
  tick. Each pickup gets its overlap cost (the conflict resolution rounds it
  is expected to bring), its tier and the overlap bound. A pickup that waits
  says so in the tick's receipt and report, on the dashboard's queue and in
  `jig ask pickup@…`: `waits on overlap: …` or
  `waits on the overlap bound: …`, with each pull request or pickup it waits
  on. A pickup whose footprint is unknown, or derived from its area labels
  alone, carries a `footprint unknown: …` note whether it waits or not. A
  file that keeps work over the bound in 3 ticks of a day gets a proposal to
  serialize it with `history.ts --propose-serialize`.
- `dispatch.overlap` in `.config/jig.yaml`, read from the default branch:
  `max_per_file`, `patience`, `file_rate`, `area_rate`, `unknown_cost`,
  `ignore`, `quiet_after` and `bound_patience`. An unknown key under it is
  refused, as the `dispatch` section refuses one, which stops the
  repository's dispatch until it is fixed.
- The state database gains `overlap_waits` and `overlap_hotspots`. They
  record how long each pickup has waited on overlap and how often a file
  kept work over the bound.
- The audit's configuration check validates the `dispatch.overlap` keys; its
  schema gains a `number` type for the rates, a fraction between bounds.
