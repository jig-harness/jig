---
release: minor
---

### Added

- [M12](../modules/M12-parallel-agent-ergonomics/README.md) states the
  control channel into an unattended agent as a practice: binding
  directives are a closed set enforced by code that fails closed, and notes
  only advise. `drive-pr`'s drive mailbox is its runnable form, and
  [mappings.md](../modules/M12-parallel-agent-ergonomics/mappings.md#control-channels)
  compares it with what agent runners offer. The audit scores it as a new
  Standard criterion, `unattended-agent-control-channel`, expected-absent
  where no agent runs unattended; the drive mailbox meets it only with its
  push-hold recheck wired as the last pre-push hook command. The worktree
  ergonomics template carries it as rule 9.
- [The memory tiers](../modules/M9-tasks-memory/templates/MEMORY-TIERS.md)
  name the machine-local store: a per-clone folder outside every worktree
  for what the worktrees of one machine share, which must hold no work state
  the tracker lacks, and the review-loop record that does not meet that yet. They also say how the several agents of one worktree share its
  scratch directory. The M9 audit criterion `memory-location-designated`
  observes where shared state lives.
- Glossary entries for the control channel and the machine-local store; the
  worktree scratch entry names `.context/`.
