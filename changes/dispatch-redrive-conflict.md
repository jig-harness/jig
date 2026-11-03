---
release: minor
---

The dispatcher no longer leaves a pull request that stopped on a conflict
waiting for a person it may not need.

### Changed

- `jig dispatch` re-drives a drive that stopped with exit `9` (still conflicting with its base once its conflict-repair budget is spent), on any admitted account, once for each pair of the pull request's head and its base branch's head, whether the forge still reports it conflicting or now reports it mergeable. It tells a person only when that re-drive leaves the ledger stopped `9` at the same pair; a head or a base that moves is a new attempt. The tick reads the base branch's head for such a ledger only, and a head or a mergeability that does not read leaves the pull request unplaced for that tick. A headless Claude pass can commit only where `drive.pass_args` names a permission mode: see that field in [CONFIGURATION.md](../plugin/CONFIGURATION.md#drive).
- An outcome row for exit `9` now reads `exit 9 (conflicting with its base)`, still under the class `gates failed`.

### Fixed

- A `conflict-resolve` pass that stopped short of concluding its merge (its commit refused, its deadline reached) left the merge open in the tree, where the stop's own `Fix:` command, `base-sync.ts`, `finish-round.ts`, convergence and an attach over a moved head all refused it. `drive.ts` now aborts a merge the pass started and did not conclude before it re-gates or stops, and the driver log lists what the merge held. A merge the tree already held when the pass started is left to the pass, which `drive-pr`'s `SKILL.md` § 0 now tells to finish it or start it over, and the stop names it if it does neither.
