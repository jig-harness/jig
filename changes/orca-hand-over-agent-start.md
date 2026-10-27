### Changed

- **Breaking** for a workspace launcher that relied on its Orca provider
  starting `claude`: without an `agent` setting the launcher now starts no
  agent. The worktree opens in Orca, the repository's create hook runs in its
  `setup` tab without holding the launch, and the first prompt goes onto the
  clipboard and into the worktree's Orca comment, for the person to start the
  agent, model and effort they choose. Set `agent` (with optional `model`,
  `effort` and `surface`) to keep the agent started
  ([tools/launcher](../tools/launcher/README.md)).

### Added

- The Orca workspace tool passes `--model`, `--effort` and `--surface` to
  the agent it starts, and with `--no-agent` runs the create hook in a
  background `setup` tab, still once per worktree
  ([tools/orca](../tools/orca/README.md)).
