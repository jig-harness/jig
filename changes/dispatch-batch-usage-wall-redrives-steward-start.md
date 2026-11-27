---
release: minor
---

### Added

- `jig send steward@owner/name start` asks the dispatcher on the host that owns the repository to start one steward pass on its next tick, even when the judgment backlog is empty or already judged. A request is refused while a steward pass holds the repository or the host's hourly budget of three passes is spent; the send's output, the tick's receipt and the dashboard name the rule, and the outcome log tells requested passes from triggered ones. **Consumer action:** none.
- A repository can choose how many times the dispatcher re-drives a stalled drive, a drive whose CI repairs ran out, or a drive stopped on a conflict with its base, before a person is told: `dispatch.redrive.stalled`, `.conflict` and `.ci` (default `1`; `0` tells a person at once). Each host caps what its repositories may ask for with `redrive_max` in its dispatch file (default `1`). **Consumer action:** none.
- When a tick has no credential for a repository's tracker, the dispatch dashboard marks that repository "tracker kept", with the time of the reading its item cards and needs come from and the reason, and `jig ask --waiting` reports the same in a new `trackerKept` field and a text block. **Consumer action:** none.

### Fixed

- A Claude follow-up, steward run or headless pickup that stops on the vendor's usage-limit notice now walls its account until the reset the notice states (or for `wall_backoff` when the reset does not read), however long the pass ran. The dispatcher no longer keeps launching passes there that die at once, and a pickup stopped this way goes to another free account without asking a person. **Consumer action:** none.
- A re-armed drive that stops because its pull request is not judgeable yet (exit 4) is no longer re-armed on the same head at once: it waits a back-off that grows each time (`not_settled.backoff`, 15 minutes), unless a review of that head, a new head or settled mergeability shows up first. After `not_settled.notify_after` (3) such stops on one head, a person is told once, with the state the drive kept reporting. **Consumer action:** none.
- An epic whose execution plan cannot be applied, or does not name one of its open children, now raises one need on the epic (`epic-plan`: re-run the planner or remove the plan), shown in Needs you and `jig ask --waiting`, and each child it holds names that need in the Queue. A plan step waiting on its predecessors names the one it waits on and that predecessor's state. **Consumer action:** none.
