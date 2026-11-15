---
release: minor
---

### Added

- A drive the dispatcher runs now leaves a closing report too, written by its driver. Every drive pass ends its round with a round report, the same fields as a closing report, through the new `round-report.ts`; it is kept in the drive's state directory, stamped with the pass's launch and round, and never in the handoff narrative. When `drive.ts` stops, it composes the closing report: the stop's own line followed by what the last round report of its launch concluded, within 600 characters, and the cause and next step the terminal-state table now gives each exit (printed in the protocol's chapter on the drive's exits). At a park it carries the first parked decision's question and framed options. The wrapper records the report under the launch record before the exit, and prints whatever report a run keeps as its last lines; a follow-up pass that could not start gets the wrapper's own report, with cause `startup` or `usage-limit`. See [plugin/README.md](../plugin/README.md#the-closing-report).
- The launch record of a dispatched drive keeps each round's pass session id, so a run is found in its vendor's transcripts (dispatch database schema 35).
- The end the wrapper writes onto a shared claim, a drive's launch claim or a follow-up marker, now names who wrote the run's closing report (`by`) and its `cause`, never the report's text.
