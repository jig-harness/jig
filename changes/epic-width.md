---
release: minor
---

### Changed

- **Breaking:** the dispatcher starts an assigned epic's ready children in parallel when the epic has no execution plan, up to a per-epic width, instead of one child at a time. The width is the new `dispatch.epic_width` key of the repository's `dispatch` section, read from the default branch, and defaults to 4. A started child counts toward it while it still needs an agent, and so does a child that cannot be read; a child in `ops_pending` or waiting on a person does not. A child that waits on the width names the epic and the width. A repository that wants the old behaviour sets `dispatch.epic_width: 1`. An epic with an execution plan is unchanged, and an interactive `do-item` session still takes one child. The audit's configuration schema gains the key. Why: [ADR-0024](../docs/adr/ADR-0024-epic-children-are-admitted-in-parallel.md). **Consumer action:** advised at configuration, instructions. A repository whose epics must run one child at a time sets `dispatch.epic_width: 1`; runbooks that say the dispatcher works an epic one child at a time say what is true now. **Detect:** `text:one child at a time`.
