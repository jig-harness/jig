---
release: minor
---

### Fixed

- **Breaking:** The dispatcher no longer starts an item that has no priority, assigned or from the ready pool, which it used to place after every low-priority item. The line lists the item in its queue with the priority it lacks; once a person sets one, or the steward's `facet` record fills it for an assigned item, the next tick ranks and starts it. A repository that wants such items started anyway sets `dispatch.missing_priority: start` ([configuration](../plugin/CONFIGURATION.md#dispatch)). **Consumer action:** advised at configuration. Give the items the dispatcher starts a priority, or set `dispatch.missing_priority: start` where the repository does not rank its items. **Detect:** `config:!dispatch.missing_priority`.
- A served batch no longer stops on a question about a member's priority. The dispatcher leaves an item with no priority out of the batches it forms, as `work-batch` already does, and a batch's pass leaves a member whose priority was cleared after the batch formed for its own pickup.
- The missing-priority hold is read again when a pickup launches and when a pending pickup is retried, so clearing an item's priority after planning no longer starts it. A Jira priority the configuration maps to none of Jig's is treated as ranked, not as missing, so list every priority the project uses under `issue_tracker.jira.priorities` to order its items. A pending batch pickup is checked for each member's priority too, and a batch that ends with no member claimed because priorities were cleared holds each member only until it changes.
