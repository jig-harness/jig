---
release: patch
---

### Fixed

- `jig gc` collects finished Orca workspaces on a machine with more than 200
  of them. It read Orca's workspace registry without asking for more than
  Orca's default page of 200 rows, took the cut page for an incomplete
  registry and marked every Orca workspace unverified, so none was ever
  removed. It now asks for the whole registry.
