---
release: minor
---

### Added

- A drive labels its own pull request as soon as its ledger changes, with no dispatcher needed: `jig:driving` once it arms, before its first round (removing `jig:drive` in the same write), and `jig:converged` or `jig:parked` when it stops converged or on something a person settles. The write is best effort: a refused write is reported on the drive's output, never changes its exit, and leaves a pull request carrying `jig:hold` or `jig:held` as it is. See [CONFIGURATION.md § dispatch](../plugin/CONFIGURATION.md#dispatch).
- A follow-up sets `jig:followed-up` or `jig:followup-failed` when it ends, whether the dispatcher ran it or a person did: the dispatcher's wrapper writes it once the pass's exit is recorded, `jig dispatch marker done` writes `jig:followed-up`, and the new `jig dispatch marker failed <PR> --comment <id>` writes `jig:followup-failed` and leaves the run's marker claiming the follow-up.
- `jig dispatch labels [--repo <path>]... [--yes]` creates the state labels, with the manual-operations label and `automation`, once, without installing the dispatcher's job, and says which labels it created and which a person must create, each with its command.
- An optional workflow template, drive-pr's `templates/github/state-labels.yml`, replaces `jig:converged` with `jig:stale` on a push to the pull request, without waiting for the dispatcher.

### Changed

- The pull request state labels are one projection in the plugin's shared code, which the drive, the follow-up and the dispatcher all write through; `dispatch.labels.enabled` and `dispatch.labels.prefix` are read by each of them from the configuration where it runs, so a repository that only drives pull requests can turn the labels on.
- The dispatcher reads a pull request's drive ledger again just before it writes its state label, and leaves the pull request to a later run when the ledger changed since it read it, so it never puts back an older state over the label a drive just wrote.
