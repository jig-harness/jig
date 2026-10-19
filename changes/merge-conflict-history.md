---
release: minor
---

### Added

- `resolve-conflicts` reports where a repository's merges conflicted, and
  why: `bun <skill-dir>/scripts/history.ts` replays every merge commit of the
  last 30 days (`--days`, `--since`/`--until` or `--all` for another range)
  with `git merge-tree`, which changes nothing in the repository, and lists
  the conflicted paths most often first, each with a cause (a lockfile, a
  release version, a count, a list every change adds to, two changes to the
  same lines, …) and the change that removes it. It also names the
  [conflict hotspots](../GLOSSARY.md), shows each week's conflicted merges by
  cause so the effect of a fix shows, reads the decisions earlier
  resolutions recorded in their `Conflicts resolved:` sections, and says how
  often each cause was right when a sample was checked by hand. `--json`
  prints it as a versioned `merge-conflicts/v1` object. It needs git 2.38 or
  later. See the skill's
  [history report section](../plugin/skills/resolve-conflicts/SKILL.md#where-past-merges-conflicted-the-history-report).
- `resolve_conflicts.hotspot_min_merges` in `.config/jig.yaml`: how many
  merges in the report's range a path must conflict in to count as a
  hotspot (3 by default).
