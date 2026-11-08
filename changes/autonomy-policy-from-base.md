---
release: minor
---

### Changed

- A drive reads `autonomy.max_level` and `autonomy.park_classes` from the
  pull request's base branch, not from the pull request's own checkout, so a
  pull request that raises the ceiling or drops a park class takes effect
  only after it merges. The ceiling's fallback comes from the base too: the
  base's `max_level`, else the base's `level`, else `attended`; a
  `JIG_OVERLAY` redirect no longer moves either field in a drive. The driver
  resolves the base's commit at its start and before every round and hands
  it to its passes in `DRIVE_PR_POLICY_BASE`; the line it prints each round
  names that commit. A session with a person in it reads both fields from
  the working tree, as before
  ([configuration](../plugin/CONFIGURATION.md#autonomy)).

### Security

- When the base branch's policy cannot be read (its commit is not in the
  clone, git fails, or the file does not parse or names an invalid ceiling
  or class list), a drive fails closed: it runs at `attended`, the only park
  classes are `escalated`, `human-decision` and `human-thread`, and the pass
  parks every decision under `human-decision` until the policy reads.
