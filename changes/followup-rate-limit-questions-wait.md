---
release: patch
---

### Fixed

- A dispatched follow-up whose pass stopped on a question naming a rate
  limit no longer waits for a person. This covers a pass from before
  passes recorded `waits`, and one that asked instead of recording it. The
  dispatcher now treats it as a wait until an hour after the pass ended, then
  starts the follow-up again. A question that also carries a
  [routine question](../GLOSSARY.md) tag keeps that class's handling.
  **Consumer action:** none.
- A person who restarts a follow-up that went to them after three
  rate-limit waits in a row now gets a fresh count. Deleting its marker, or
  choosing "Run it again", starts that count again. Before, the follow-up
  could come straight back to the person on its next wait.
  **Consumer action:** none.
