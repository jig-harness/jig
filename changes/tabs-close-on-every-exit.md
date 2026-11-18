---
release: minor
---

### Changed

- A run the dispatcher launches in an Orca terminal tab now closes its tab
  however it ended: a park, a failure, a deadline and a usage-limit stop
  close it too, since the run's closing report, or the cause recorded for
  it, keeps what the tab showed, and a drive's output stays in its driver
  log. A terminal someone typed a command into still stays open. A drive you
  arm in a tab yourself keeps its tab after a park or a failure, as before.

### Added

- The session runtime interface has `endRun`: when a tick with `--apply`
  finds a run that ended without its wrapper recording an exit, it asks the
  runtime to end what the run left, once. On Orca that closes the run's
  recorded tab while nothing runs in it; the dispatch report lists what it
  closed (`end run`), and a tab it leaves is `jig gc`'s `orca-terminals`
  kind's to collect. A run tab now records the launch record it runs; a tab
  recorded by an earlier release names none and is left to `jig gc`.
