---
release: minor
---

### Added

- A drive labels its own pull request whenever it writes its ledger, with no dispatcher needed: `jig:driving` once it arms, before its first round (removing `jig:drive` in the same write), and at its stop the state one exit table gives both the drive and the dispatcher: `jig:converged` while the head is the one it verified, `jig:parked` for a park, a stop a person settles or made, and a stop the dispatcher re-drives (which a dispatcher turns into `jig:stale`). The write is best effort: a refused write is reported on the drive's output and never changes its exit, and a pull request carrying `jig:hold` or `jig:held` is left as it is. See [CONFIGURATION.md § dispatch](../plugin/CONFIGURATION.md#dispatch).
- A follow-up sets `jig:followed-up` or `jig:followup-failed` when it ends, whether the dispatcher ran it or a person did: the dispatcher's wrapper writes it once the pass's exit is recorded, `jig dispatch marker done` writes `jig:followed-up`, and the new `jig dispatch marker failed <PR> --comment <id>` writes `jig:followup-failed`, leaves the run's marker claiming the follow-up, and exits `1` when that label is not written.
- `jig dispatch labels [--repo <path>]... [--yes]` creates the state labels, with the manual-operations label and `automation`, once, without installing the dispatcher's job, and says which labels it created and which a person must create, each with its command.
- An optional workflow template, drive-pr's `templates/github/state-labels.yml`, replaces `jig:converged` with `jig:stale` on a push to the pull request, without waiting for the dispatcher.

### Changed

- The pull request state labels are one projection in the plugin's shared code, which the drive, the follow-up and the dispatcher all write through; each of them reads `dispatch.labels` from the repository's default branch, so a repository that only drives pull requests can turn the labels on, and every writer uses one prefix. With `only_labeled` on, a drive armed by hand now comes into the dispatcher's scope through its own `jig:driving` label.
- The dispatcher reads a pull request's drive ledger again just before it writes its state label, and leaves the pull request to a later run when the ledger changed since it read it, so a drive's label for a newer ledger is not replaced from the older one the run planned from.
