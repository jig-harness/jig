---
release: patch
---

### Fixed

- A batch pickup that ended after claiming some of its members no longer
  holds the members it never claimed: they are wanted again at the next
  tick, whether the pass recorded `done` or `failed`. A pass that ended on a
  question keeps them until a person answers it.
- A served epic without an execution plan no longer gives its one-child slot
  to a child this host's ended pickup record keeps from starting: its next
  startable child takes the slot, and the epic names the held child and why.
- An item an ended pickup record holds, with no question and no rule to
  release it, is now a need for a person, framed with its options (pick it
  up again, or leave it) and listed by `jig ask --waiting`, rather than a
  quiet `pickup-ended` line. **Consumer action:** none.
