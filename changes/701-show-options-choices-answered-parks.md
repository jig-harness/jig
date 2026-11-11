---
release: minor
---

### Added

- `jig ask … --thread --json` shows what a parked decision offers and what each person chose: a `question` entry from a framed decision carries its `key`, its [decision digest](../GLOSSARY.md) and its `options`, each numbered with the recommended option first, and an `answer` entry carries its `key` and the `choice` it made with its `note`, or `free: true` for an answer in the person's own words, or `stale` with the digest of the earlier framing it named. See [plugin/README.md § Asking a station](../plugin/README.md#asking-a-station-where-it-stands).
- The dashboard's Needs you card says what the answers that keep a decision waiting chose, and whether they are stale or [disputed](../GLOSSARY.md), with the same options and choices `jig ask` shows for that park.
- When a re-arm unparks answered items, it leaves a [resolution receipt](../GLOSSARY.md) for each in the drive ledger (`resolvedParks`, the last 10, or every one a single re-arm wrote when it unparked more): the park's key, digest and the time it was parked, the answers it consumed, the outcome and the times. `drive-state.ts unpark --stdin` writes them in the same change that removes the parks.
- The outcome log counts how each park left its ledger, on the host that owns the repository: `park-answered` (with the class, the answers' form, whether the recommended option was chosen, whether a note narrowed it and how long the park waited), `park-provisional`, and `park-removed` for a park that left with no receipt. A park raised and answered between two ticks is counted, and none is counted twice. See [plugin/README.md § The dispatcher](../plugin/README.md#the-dispatcher).
