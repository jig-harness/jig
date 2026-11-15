---
release: minor
---

### Added

- `jig gc` has a machine kind, `orca-terminals`, that closes the Orca run tabs a killed run left behind and parked run tabs nobody returned to. It is planned when the user file's `gc` section names `orca.command`; a tab is closed only once its shell runs no command and it has been idle past `gc.orca.terminal_idle_hours` (24 by default). It closes the recorded terminal, never its whole tab, so a pane a person added beside it stays; `jig gc --kind orca-terminals` reports each tab with its proof and closes nothing.
