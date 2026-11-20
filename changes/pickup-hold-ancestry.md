---
release: patch
---

### Fixed

- `jig dispatch`: a person's hold on an epic nested inside another epic now stops the work under it even when the hold arrives after the tick read its holds. Before, the check made just before a pickup launches looked only at the item and its outermost epic, so a leaf under a held nested epic could still start, alone or in a batch. The served queue, its batches and the pickup's launch record now carry every epic above the item, and that last check refuses the launch when any of them is held. Launch records written by an earlier release are still read, and checked against the one epic they name.
