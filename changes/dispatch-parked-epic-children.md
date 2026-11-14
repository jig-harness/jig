---
release: patch
---

### Fixed

- A served epic without an execution plan can start its next child while
  earlier children await a person in operations-pending or carry a person-hold
  label. When nothing can start, its Queue summary names a child waiting on
  a person. **Consumer action:** none.
