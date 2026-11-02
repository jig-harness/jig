---
release: minor
---

The dispatcher shows its state on each pull request as a label, and takes
a person's commands the same way.

### Added

- **Dispatch labels** (`dispatch.labels` in `.config/jig.yaml`, off by
  default). With `enabled: true`, every `jig dispatch --apply` run keeps
  one state label on each pull request it manages, derived from its drive
  ledger: `jig:driving`, `jig:converged`, `jig:parked`, `jig:stale`, and
  `jig:followed-up` once a merged pull request's follow-up is done. A run
  writes only where the labels disagree, one forge call per pull request,
  so a label changed by hand comes back at the next run; the dispatcher
  never reads a state label to decide what to start. `prefix` replaces
  `jig:` for a repository whose label taxonomy has its own convention.
  A run without `--apply` reports what it would write, and a write the
  forge refuses is reported in the receipt without failing the run.
- **Commands a person gives with a label.** `jig:drive` on a pull
  request with no drive ledger arms a drive on it (the machine file's
  `rearm` stage, once per head commit), and is replaced by the state label
  once the ledger exists. `jig:hold` keeps every stage off its pull request
  while it is there; each run reports it, and only a person removes it.
- **`only_labeled: true`** limits the dispatcher to the pull requests that
  carry a label of the set: one with none is never read, re-armed or
  followed up.
- **`jig dispatch install --repo <path> [--yes]`** lists the dispatch
  labels a repository lacks, and with `--yes` creates them where the
  signed-in account may, listing the rest with the command a person runs.
  Run it once after turning the labels on: the labels must exist before a
  run writes them.
- **The morning report** (`drives.ts --report`) gives, for each repository
  with the labels on, how many pull requests its latest run projected each label for (`dispatchLabels` in `--json`).
