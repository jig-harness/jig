---
release: minor
---

### Added

- `resolve-conflicts`' `history.ts --rates` prints, for each path, how many
  merged pull requests of the range changed it and how many of those met a
  conflict before they merged (`merge-conflict-rates/v1` JSON). It reads the
  merged pull requests from the forge in one bounded listing, which
  `--cohort-cache` keeps for the next run, and leaves out a pull request
  whose conflicts it could not observe. `--out` writes the rates whole or not
  at all: a listing that fails or reaches its bound keeps the file already
  there, and the run exits 3.
- The dispatcher refreshes those rates for each repository it starts
  pickups in, at most once a day, after its act phase and under a deadline,
  in `~/.local/state/jig/dispatch/conflict-rates/`. A refresh that fails,
  reads an incomplete listing or runs past its deadline keeps the previous
  rates and says why in the tick's error output. Nothing reads the rates to
  order work yet.
