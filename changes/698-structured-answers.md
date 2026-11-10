---
release: minor
---

### Added

- Answer a parked decision with `approve` for its recommendation or
  `choose <option name>`, optionally followed by a `note <key>:` condition.
  The drive receives the chosen option and decision. Other wording remains
  a free answer, and `jig ask` labels how it was read.

### Changed

- **Breaking:** new parks refuse option names that become identical after
  answer normalization or change when the public ledger redacts them.
  Rename colliding options and remove email addresses and account identifiers
  from option names before parking them.

### Fixed

- Re-arm, dispatch, `jig ask` and `jig send` read the same conversation and
  thread answers, using each person's latest edit. Conflicting choices or
  notes leave the decision disputed and notify the people involved; no
  item with a person's answer is decided provisionally.
