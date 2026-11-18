---
release: patch
---

### Fixed

- `jig dispatch` no longer stops a fixed batch on a question about a `medium` member. The most expensive batchable size is picked up on its own and the smaller items go on as the batch; with fewer than two left, each is its own pickup. A member whose size changes after the tick is left out by the batch's pass, through the proposal's new `--fixed` option. A person running `/jig:work-batch` is still asked for the verdict.
