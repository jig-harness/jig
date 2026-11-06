---
release: patch
---

### Fixed

- On Linux, a dispatcher tick that no Orca terminal started (a wake-up from
  Orca's plugin, or any run without `ORCA_CLI_COMMAND`) reads and starts
  sessions through `orca-ide`, the name Orca installs its command under
  there. It ran a bare `orca`, which on a desktop with GNOME's screen reader
  installed is the screen reader: every such tick failed its runtime read
  (`orca repo list failed (exit 1): … dbind-CRITICAL …`) and started
  nothing. `jig doctor`'s `dispatch:orca` check looks for the same command.
