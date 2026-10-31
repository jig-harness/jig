### Added

- [M12](../modules/M12-parallel-agent-ergonomics/mappings.md#worktree-managers--agent-runners--where-the-hooks-wire)'s mappings say where Worktrunk runs a repository's worktree create and remove hooks: its blocking `pre-start` and `pre-remove` hooks in `.config/wt.toml`, each inside the worktree, so a failed remove hook keeps the worktree and its unsent reflection findings.
