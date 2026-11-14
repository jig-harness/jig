---
release: minor
---

The turn-budget guard no longer asks Codex for a new approval with every Jig release.

### Changed

- **Codex: the turn-budget hook is registered by `jig upgrade`, not shipped by the plugin.** Codex re-reviews a plugin's hooks whenever any file of the plugin changes, and skips them until it is approved again. The Codex plugin now ships none. `jig upgrade` adds one `PreToolUse` entry to `$CODEX_HOME/hooks.json` (`~/.codex` by default) whose command never changes and runs the installed plugin copy's guard, so approving it once with `/hooks` stands across releases. After this release, approve the guard once in each Codex home; until then it does not run there. Run `jig upgrade --codex` with `CODEX_HOME` set to give another home the entry. `jig uninstall --machine --yes` removes it. Claude Code is unchanged. **Consumer action:** required at machine. Run `jig upgrade --codex` and approve the guard with `/hooks` in every Codex home that runs unattended passes.

### Added

- **Documented: unattended Codex passes and hook trust.** The Codex notes and the host's opt-in to bypass say that a headless `codex exec` runs only approved hooks, to approve the guard once per Codex home, and that a host which vets every hook its Codex home loads may set `drive.codex_pass_args: [--dangerously-bypass-hook-trust]` for Jig-generated Codex passes.
