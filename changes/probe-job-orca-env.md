---
release: patch
---

### Fixed

- The dispatcher's change probe job (`jig-dispatch-probe`) is now installed
  with the same Orca command configuration (`ORCA_CLI_COMMAND`,
  `ORCA_CLI_BIN_DIR`) as the tick's job. Before, only the tick's job took
  these from the installing shell. `jig upgrade` keeps whatever the installed
  probe job already holds. A probe job installed before this release gets the
  values from the next `jig install dispatch --yes`.
