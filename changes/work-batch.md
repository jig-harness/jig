---
release: minor
---

Several small issues from one area of the code can now be closed in one pull request, from the plugin.

### Added

- `/jig:work-batch` ([plugin/skills/work-batch/](../plugin/skills/work-batch/README.md)) groups several small, independent issues from one area of the code into one pull request, one commit per issue, and drives it once. Its proposal takes an area, a path, an epic or one issue as the anchor, reads the open issues through the tracker interface, holds back every issue that may not join (solo-only flags, an area the catalog flags, an urgent priority, truncated labels, missing size, type, repository or context labels, a state it cannot read, ownership), ranks the rest and fills a point budget and an item limit. It claims the batch, trims it when it outgrows its budget, opens the pull request under `do-item`'s pull-request policy and arms `drive-pr`. After the merge it closes out every issue the batch closed, moves each parent epic forward and records the batch's close/open ratio.
- The solo-only flags are derived from the repository's configuration: `issue_tracker.labels.hitl` and its facets, `issue_tracker.labels.manual_ops`, and every flag in the change-area catalog. `work_batch.solo_flags` adds to them; no setting removes one.
- `candidates.ts --eligibility` reads issues on standard input, reads no tracker, and prints one versioned JSON document: the effective policy and each issue's verdict, decided by the same rules the proposal uses. A dashboard or a planning view asks it instead of keeping its own copy of the rules; the format is in the skill's SKILL.md.
- A `work_batch` section in `.config/jig.yaml` (`point_budget`, `size_points`, `max_items`, `solo_flags`, `sizes`, `ranking`), documented in [CONFIGURATION.md](../plugin/CONFIGURATION.md#work_batch). A repository whose `issue_tracker.labels.batch_sizes` differ from `xs`, `small`, `medium` sets `work_batch.size_points` for its own sizes; `work_batch.sizes` (every size label) turns on the report of issues with no size label.
- `do-item`'s `intent-chain.ts --clear-session` removes the current session's intent-chain copy, so Refocus stops putting work in front of an agent that gave it up.
- The audit's configuration check knows the `work_batch` section and reports `work_batch.size_points` that do not price exactly `issue_tracker.labels.batch_sizes`.

### Changed

- `do-item`'s batch check runs `/jig:work-batch`'s proposal for a small issue and suggests the batch it finds, instead of asking for a batching skill of the repository's own. It still never batches silently.
