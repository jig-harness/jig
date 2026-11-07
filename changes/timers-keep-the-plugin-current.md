---
release: minor
---

The installed timers now keep the plugin current: a machine that runs the dispatcher stays on its channel's newest version with nobody at the keyboard.

### Added

- Before each job a timer starts (`jig gc --scheduled`, `jig dispatch --apply`), its launcher runs the installed plugin copy's new `jig upgrade --scheduled`, then runs the job on the copy now installed. It updates the plugin on the channel each agent tool follows and refreshes the launcher copies and the `jig` command, at most once per `upgrade.every` (an hour) whichever timer fires first. A failed upgrade is not tried again inside the interval, and the job still runs on the copy that is there. A machine pinned to a tag or ref receives nothing, and a plugin Claude Code loads in place from a local marketplace folder is skipped and that folder left untouched. The `jig` command and a woken dispatcher tick never upgrade first ([automatic updates](../plugin/README.md#automatic-updates)).
- The user file's `upgrade` section: `upgrade: off`, or `every` and `enabled`; `jig install --no-upgrade` writes `upgrade.enabled: false` ([CONFIGURATION.md](../plugin/CONFIGURATION.md#upgrade-user-file-only)).
- Each timer run's receipt carries an `upgrade` line (withheld, skipped, unchanged, `0.114.0 -> 0.115.0`, or failed with the agent tool's error), shown by `jig receipts gc` and `jig receipts dispatch`; the drive morning report lists the updates and the failures since the last report, under `upgrades` in its JSON.
- `jig doctor`'s `upgrade` check fails while the latest scheduled upgrade failed, naming it and the agent tool's error.

### Changed

- On a machine whose timers upgrade the plugin, a drive's rounds may span plugin versions: the driver keeps the copy it started with, and each pass runs the copy installed when it starts.
- A scheduled refresh leaves a loaded launchd job's file as it is, since rewriting it stops the job; `jig upgrade` run by a person rewrites it.
