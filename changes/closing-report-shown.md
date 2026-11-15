---
release: minor
---

### Added

- The dispatch dashboard shows each run's closing report. On the History view, every run's line says what it concluded, the next step it suggests and why it fell short, or that it ended without a report; the log filters on the report's cause and on who wrote it; and a row opens to all runs of its piece of work, newest first, each with its report and, where the report's suggested next step names another owner than the tick's own next owner, both side by side. *Needs you* shows a report's question and framed decision where it showed a pass's `Question:` line, with what the run concluded beside them. See [plugin/README.md](../plugin/README.md#the-closing-report).
- `jig ask`'s answer gains a `last.run` line: the last run's stage, when it ended, what it concluded and the next step it suggests, or that it ended without a report. `--json` carries them as `last.stage` and `last.report`, and the operator skill's status card relays them.
- Where the `notify` stage runs, each of its ticks writes one `notices_read` event to the outcome log with the notices workspace's read state, the observation the stage's retirement measure reads. The dashboard's log leaves these rows out unless its class filter names `event: notices_read`.
