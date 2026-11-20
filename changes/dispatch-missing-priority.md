---
release: minor
---

### Fixed

- **Breaking:** The dispatcher no longer starts an assigned item that has no priority, which it used to place after every low-priority item. The line lists the item in its queue with the priority it lacks; once a person sets one, or the steward's `facet` record fills it, the next tick ranks and starts it. A repository that wants such items started anyway sets `dispatch.missing_priority: start` ([configuration](../plugin/CONFIGURATION.md#dispatch)). **Consumer action:** advised at configuration. Give assigned items a priority, or set `dispatch.missing_priority: start` where the repository does not rank its items. **Detect:** `config:!dispatch.missing_priority`.
- A served batch no longer stops on a question about a member's priority. The dispatcher leaves an item with no priority out of the batches it forms, as `work-batch` already does, and a batch's pass leaves a member whose priority was cleared after the batch formed for its own pickup.
