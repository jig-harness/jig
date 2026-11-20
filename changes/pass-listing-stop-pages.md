---
release: patch
---

### Fixed

- A drive whose review pass stops on an unreadable check-runs listing now names the pages that pass read on its stop line (`pass reported CHECK_RUNS_UNREADABLE after <n> page(s) on round <r>; stopping`), as its own listing stops do. A page count in the pass's finish record that is not a whole number reads as unknown.
