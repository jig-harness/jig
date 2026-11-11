---
release: minor
---

### Changed

- A served batch pickup that the repository's start rules
  (`do_item.preflight_command`) refused for one member now holds only that
  member. The pass records `jig dispatch result <record> <token> failed
  --refused <updated-at> --key <item> --reason <reason>`, repeating
  `--refused` and `--key` for each member refused. The dispatcher holds each
  named member until its own `updatedAt` moves, and picks the rest of the
  batch up again without them. A single-item pickup, and a refusal recorded
  without `--key`, are held as before: on one time for the whole pickup.
