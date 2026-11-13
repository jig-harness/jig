---
release: patch
---

### Fixed

- `tracker.ts claim` with `do_item.claim_marker`: a claim that met an earlier claim's marker only after it had assigned and started the item could stand down while the earlier attempt refused too, leaving the item started with nobody working on it. Each attempt now records how it ended in an outcome comment beside its marker (claimed, released or unresolved), and a marker whose attempt released holds nothing. A claim that stands down after its writes never undoes them: it keeps the item when its own marker still shows and every earlier attempt recorded a release (`"recovery": "reclaimed"`), stands down when one recorded its claim (`"held"`), and stands down `"unresolved"`, leaving the item for a person, when the outcomes cannot settle who holds it.
