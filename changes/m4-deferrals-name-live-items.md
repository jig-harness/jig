---
release: minor
---

Documents that defer work to the tracker can no longer rot silently: M4 gains a static gate for deferrals that name no item and a scheduled check for deferrals whose items have closed.

### Added

- [M4](../modules/M4-docs-governance/README.md) states a new practice, deferrals name live items: a document that defers work to the tracker ("tracked to closure", "a follow-up will be filed") names the item that carries it, and the item stays open. [`reference/deferral-references/`](../modules/M4-docs-governance/reference/deferral-references/README.md) is the gate. Its static half is offline and judges the lines a change adds (`--staged` for a hook, `--range` for a pull request), or every document with `--all`. A block of prose with a configured marker phrase and no item reference is a finding, a waiver needs a stated reason, and a configuration or range it cannot read is exit 2. Its live half (`--all --list-keys`, then `--all --states <file>`) takes the tracker's answers as a file, so the check never holds a credential: a deferral fails when none of the items it names is open, and an item with no recorded state fails the run instead of passing.
- [`templates/deferral-references.yaml`](../modules/M4-docs-governance/templates/deferral-references.yaml) (item patterns, marker phrases, scope) and [`templates/deferral-liveness.yml`](../modules/M4-docs-governance/templates/deferral-liveness.yml), a scheduled workflow that holds the tracker credential in one step, on the default branch only. The [mappings](../modules/M4-docs-governance/mappings.md#deferral-references) give the hook, CI and per-tracker provider recipes.
- `tracker.ts issue-states` in the `do-item` skill reads item keys on standard input and prints each one's state as `open`, `closed` or `not_found` through the tracker interface; it is the provider the liveness check uses for Linear. A lookup that fails, or an issue the tracker reports without a state category or with one that is neither open nor closed, fails the command.
- The audit scores new M4 criteria: `deferrals-name-items` (Standard, mechanical) and `deferral-liveness-scheduled` (Strict, mechanical). Each is `expected-absent` for a repository whose documents defer no work to a tracker. A re-audit reports them as added since the prior audit, not as regressions.
