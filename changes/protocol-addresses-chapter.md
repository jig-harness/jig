---
release: minor
---

### Added

- The Jig Protocol has a provisional chapter on addresses and the verbs of
  `jig send` ([plugin/protocol/addresses.md](../plugin/protocol/addresses.md)):
  the form of an address, the stations it names with what each one's key is,
  and every verb with the stations that take it, whether it is a person's
  command, its arguments and what it asks for. Its values are generated from
  the tables `jig ask` and `jig send` parse with, and its data file,
  `plugin/protocol/data/addresses.json`, carries them for a program that
  forms addresses or sends verbs.
