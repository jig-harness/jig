### Added

- [GLOSSARY.md](../GLOSSARY.md) defines the terms of the planned dispatcher,
  which starts the execution line's stages with nobody at the keyboard:
  dispatcher, tick, session runtime and factory identity, and the terms
  of its control function: outcome log, stage drift and nudge.

### Changed

- [ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)
  is amended: Herdr stays the first workspace runtime for Jig's tooling,
  except the planned dispatcher, which targets Orca first.
