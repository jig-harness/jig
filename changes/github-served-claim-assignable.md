---
release: patch
---

### Fixed

- A served-person pickup on GitHub Issues no longer stops with "Field 'id' doesn't exist on type 'Assignable'" when the item has no assignee: the inherited claim's assignment now selects only a field the `Assignable` interface declares, so the claim goes through.
