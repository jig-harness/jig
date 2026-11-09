---
release: minor
---

### Added

- Every need on the dispatch dashboard's Needs you view opens with what the
  person does: one act from a closed list, **Merge**, **Decide**,
  **Authorize**, **Reply**, **Do** or **Investigate**, taken from the park's
  decision class (a class with no act of its own reads Decide), then the ask
  in one sentence, the recommended option in bold with what it changes and
  costs, and the person it waits on. The other options, the steps for a
  person (as a checklist) and the evidence are folded. Needs you groups its
  cards by act and filters them by the person they wait on.
- `jig ask` names the same act as `needAct`, on a `person` wait and on each
  `jig ask --waiting` entry. A parked drive takes the act the newest tick's
  line names for it, so the answer and the card read one record.
- The line the tick keeps for the dashboard carries each need's `act`, and
  each parked decision's `options` (with their changes and costs and which
  one is recommended) and `steps`.
- The HITL registry template in M7 gains an Act column naming each class's
  act.
