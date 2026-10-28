---
release: minor
---

### Added

- The evidence record, `shared/evidence.ts` in the plugin: `run -- <command>` runs a check under a deadline and keeps one record of it on the machine, tied to the hash of the exact tree it ran against (tracked files with their staged and unstaged changes, and untracked files Git does not ignore), with its exit, the test counts per suite from the JUnit report it wrote in this run, and the first and last lines of its output. A tree that changed during the run, a report left by an earlier run, a report that is a symbolic link, a report that failed a case, a suite that ran no case and a run that hit its deadline are each recorded as what they are, never as a pass. `--expect-fail` records a test seen to fail, and a command ended by a signal is not one. `list` finds the newest record of each command that vouches for a tree. The records are readable by their owner alone, and the short block it prints names the command without its arguments and gives the report's counts without its suite or case names. Its settings are the new `verify` section ([CONFIGURATION.md](../plugin/CONFIGURATION.md#verify)): `store`, `output_lines`, `timeout_minutes` and `retention_days`.
