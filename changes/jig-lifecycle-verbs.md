---
release: minor
---

### Added

- `jig install`, `jig uninstall`, `jig status`, `jig receipts` and `jig run` act on each component of the `jig` command, resource collection (`gc`) and the dispatcher (`dispatch`), the same way: name the components (`jig install dispatch`), or none for all of them. `jig install` previews and, with `--yes`, writes each component's scheduled job; with no component named it installs resource collection and registers the current repository (or `--repo`), and installs the dispatcher only when its machine file `~/.jig/dispatch.yaml` exists, saying otherwise that it was skipped and why. `jig uninstall` removes the repository's entry, `--machine` each component's job as well. `jig status` shows whether each job is installed, its schedule, next run and last receipt (`--json` for a script). `jig receipts gc` or `jig receipts dispatch` lists a component's receipts, a date that day's, a run id one run. `jig run` runs now what each timer runs (`jig gc --scheduled`, `jig dispatch --apply`). See [the plugin's README](../plugin/README.md#the-jig-command).
- `jig install` puts the `jig` command on `PATH`: `~/.local/bin/jig` (`jig.cmd` on Windows), which runs the launcher the scheduled jobs run, from its own copy, so each run uses the installed plugin copy and a plugin update reaches it without a new install. The first install runs from the installed copy as `bun --no-env-file --config=<plugin>/gc/bunfig.toml <plugin>/jig.ts install --yes`. `jig uninstall --machine` removes the command with the jobs; a file at that path `jig install` did not write is left alone, and the install refuses to replace it.

### Changed

- `jig gc install` (with `--uninstall`, and `--machine` only with `--uninstall`), `jig dispatch install` (with `--uninstall` and `--interval`; it refuses `--machine`), `jig gc receipts` and `jig dispatch receipts` keep working as before but no longer appear in `jig --help` or a component's help, which name the lifecycle commands instead. `jig dispatch receipts <date>` now lists that day's receipts, as `jig receipts dispatch <date>` does. Jobs already installed keep running unchanged: there is nothing a consumer must change.
