---
release: minor
---

### Added

- The dispatcher's change probe: `jig install dispatch` now also writes a
  timer that runs `jig dispatch probe --apply` every minute. It makes one
  search on the forge over every repository the machine file dispatches
  (on GitHub one GraphQL call for a single page of results, 1 point of the 5,000 an hour; further pages add calls and points) and wakes the
  tick of each repository where a pull request was reviewed, commented on,
  labelled, pushed to, merged or closed, or its checks changed, since the
  last probe, so such a change starts that repository's tick within about a
  minute rather than at the next sweep. A minute with no change starts no
  tick, and a probe that cannot read the forge wakes nothing and says why.
  `jig dispatch probe` without `--apply` says what it would wake and writes
  nothing. Turn it off with `change_probe: false` in
  `~/.jig/dispatch.yaml`. `jig upgrade` keeps and refreshes the probe's
  timer; on a machine whose dispatcher timer is already installed, run
  `jig install dispatch --yes` once to add it.
- Each wake of a repository's tick now records who asked and why
  (`send: …` or `probe: …`), and the wake's `last-run.log` names them
  beside the tick it ran.
