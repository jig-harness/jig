---
release: minor
---

### Added

- `jig upgrade` updates the plugin in Claude Code and Codex, whichever is on `PATH`, to the newest release of the channel each follows, and installs it in one that lacks it (following `stable` unless `--channel latest` says otherwise). Then the newly installed copy refreshes what runs it: each installed job's launcher copy and its job (the systemd units, the launchd job or the crontab line), and the `jig` command's launcher copy and script, so a change to the launcher in a release reaches them. A job keeps the environment, schedule and programs its install recorded, nothing is written where nothing differs, and a job that was enabled or running stays so. Every command is printed before it runs; `--json` prints what became of each tool and job, and `--jobs-only` refreshes the jobs after a tool updated the plugin on its own. See [the plugin's README](../plugin/README.md#the-jig-command).
- `jig doctor` checks the machine and the repository it runs in, and names the command that fixes each failure: Bun's version against the one Jig tests, `claude` and `codex` resolving outside every git checkout, the plugin in each tool and the channel it follows, the `jig` command's and each job's launcher copy against the installed plugin's, the programs each job names, each component's machine file and last run, Orca for the dispatcher, and the audit's configuration fit of the repository, offline. It exits 1 when a check fails; `--json` prints every check.

### Changed

- `bun tools/plugin/setup.ts` runs the plugin's own install and update code and is for the first install from a checkout, before `jig` is on `PATH`; afterwards `jig upgrade` and `jig doctor` do its work and more. A tool that fails no longer stops the other: setup reports it, goes on to the next, and exits 1 instead of 2; arguments it cannot take still exit 2. On a machine that follows `main`, its advice names `jig upgrade`.
