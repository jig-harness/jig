---
release: minor
---

### Added

- drive-pr enforces a round ceiling: `drive.max_total_rounds` (default 8, at most 50) caps the review rounds of one pull request across every launch, re-arm and takeover, and `--rearm-budget` never grants past it. A drive that reaches it, or the optional wall-clock cap `drive.max_wall_clock_hours`, parks for a person with a `round-ceiling` decision that states the rounds, the elapsed time and why re-arming is refused. Answering it with "Allow one more budget", or arming with `--past-ceiling`, raises the ceiling by one round budget. See the [configuration reference](../plugin/CONFIGURATION.md) and drive-pr's [README](../plugin/skills/drive-pr/README.md).
- drive-pr stops a diverging drive: when two rounds in a row raise at least as many findings as they fix, with findings still open, the drive parks with a `divergence-stop` decision listing the counts of each round.

### Changed

- A drive's effective round budget is now the smaller of `drive.max_rounds` and the round ceiling, so with the defaults a drive stops after 8 rounds rather than 10. A repository that wants longer drives raises `drive.max_total_rounds`.

### Fixed

- An answered non-blocking `winddown-deferred` summary finding stays answered: drive-pr no longer asks it again every few rounds. A reviewer that reports the same finding as blocking is still asked.
