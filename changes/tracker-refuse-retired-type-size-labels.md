---
release: patch
---

### Fixed

- `tracker.ts update` and `create` now refuse to add a type or size label
  where the repository keeps that facet outside labels (GitHub's issue type
  or a field, Linear's estimate, a Jira field). The message names the
  facet's value and where it is kept. Taking such a label off an issue stays
  allowed, except on Jira, whose adapter refuses removing a label that is a
  `field_labels` value. Where the facet is kept in labels nothing changes.
  A caller that added such a label by hand sets the facet instead.
  **Consumer action:** none.
