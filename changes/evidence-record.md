---
release: minor
---

### Added

- The evidence record, `shared/evidence.ts` in the plugin: `run -- <command>` runs a check under a deadline and keeps one record of it on the machine, tied to the hash of the exact tree it ran against (tracked files with their staged and unstaged changes, and untracked files Git does not ignore), with its exit, the test counts per suite from the JUnit report it wrote in this run, and the first and last lines of its output. A tree that changed during the run, a report left by an earlier run, a suite that ran no case and a run that hit its deadline are each recorded as what they are, never as a pass. `--expect-fail` records a test seen to fail, `list` finds the records of a tree, and the short block it prints names the command without its arguments. Its settings are the new `verify` section ([CONFIGURATION.md](../plugin/CONFIGURATION.md#verify)): `store`, `output_lines`, `timeout_minutes` and `retention_days`.
