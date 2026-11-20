---
release: patch
---

### Fixed

- A drive whose review pass stops on an unreadable check-runs listing now records that stop as it records its own listing stop: the stop line names the pages the pass read (`pass reported CHECK_RUNS_UNREADABLE after <n> page(s) on round <r>; stopping`), and the handoff file and the ledger's stop event carry the class and the pages as a status probe stop. A page count in the pass's finish record that is not a whole number reads as unknown.
