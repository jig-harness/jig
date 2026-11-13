---
release: patch
---

### Fixed

- `jig dispatch` no longer launches a drive again, tick after tick, when
  `drive.ts` refused the last launch as a usage error (exit `2`) and the
  pull request's drive ledger has not changed since. The drive becomes a
  person's: one notice says which launch was refused and carries the drive's
  own message, which the dispatcher now keeps from the drive's error output on
  that exit. The next launch happens once the ledger moves, or when a person
  asks for a re-arm.
- `drive.ts --take-over` now takes over a drive whose ledger still names this
  working tree's own driver as running though no driver holds its lock: that
  driver ended without writing its stop, so the takeover goes ahead as a dead
  driver's and stops nothing. When the ledger names this clone's driver in
  another working tree, the refusal now names that tree and says to re-arm
  from there.
