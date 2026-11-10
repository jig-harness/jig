---
release: minor
---

A repository can now state its own rules for starting work as one command that every claim runs.

### Added

- `do_item.preflight_command`: a command `tracker.ts claim` runs before it takes the claim lock or writes anything, from the repository root, with the item's `get_issue.ts` JSON on standard input. Exit 0 goes on; exit 3 refuses the claim with the command's first line of output as the reason; any other exit, or a run past 60 seconds (`JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC` sets the bound), refuses too. `do-item` (each selected sub-issue included), `work-batch` (which drops a refused member and names it) and a dispatched pickup all claim through it, so none has to remember to call it. A repository file sets it; a user file cannot. See [the configuration](../plugin/CONFIGURATION.md#do_item).
