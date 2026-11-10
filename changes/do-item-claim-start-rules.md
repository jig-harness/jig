---
release: minor
---

A repository can now state its own rules for starting work, and every claim honours them.

### Added

- `do_item.preflight_command`: a command `tracker.ts claim` runs before it takes the claim lock or writes anything, from the repository root, with the item's `get_issue.ts` JSON on standard input. Exit 0 goes on; exit 3 refuses the claim with the command's first line of output as the reason; any other exit, more than 64 KiB of output, or a run past 60 seconds (`JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC` sets the bound), refuses too. The claim reads the command from the default branch, never from a working tree on another branch, and runs it without the tracker and forge tokens. `do-item` (each selected sub-issue included), `work-batch` (which drops a refused member and names it) and a dispatched pickup all claim through it, so none has to remember to call it. See [the configuration](../plugin/CONFIGURATION.md#do_item).
- The dispatcher holds a pickup the preflight command refused, showing the reason, until the item's `updatedAt` moves past the one the command saw; the pass records it with `jig dispatch result <record> <token> failed --refused <updated-at> --reason <reason>`.
- `do_item.claim_from`: the canonical states a claim may start work from. An item in any other state, or in a status that maps to no canonical state, is refused with nothing written (`claim` exits 3 with `"why": "state"`), in `do-item`, `work-batch` and served claims alike. Unset, a claim keeps its rule and is not limited to `dispatch.states`; `/jig:audit` warns when both are set and differ.
- `do_item.claim_marker`: a successful claim posts a marker comment on the item, a `tracker-claim-marker` record naming the session, the host (as a digest) and the branch, so other tools reading the tracker can tell which session holds it.
- The repository-command runner (`plugin/shared/repo-command.ts`) these use: a setting read from the default branch, a scrubbed environment, a deadline, bounded output and a one-line reason for any failure, for the facets command store to reuse.
