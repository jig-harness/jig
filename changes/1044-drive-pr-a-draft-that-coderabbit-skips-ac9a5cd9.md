---
release: patch
---

### Fixed

- A draft skipped by CodeRabbit through its comment alone now finishes its
  own review round, marks Ready under the repository's policy and waits for
  the review. A Ready pull request still waits when only the old skip comment
  exists. **Consumer action:** none.
