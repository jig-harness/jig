---
release: minor
---

### Added

- **`drive.codex_pass_args`: a host's extra arguments for a Codex pass.** A list of words in the host's user file (`~/.jig/jig.yaml`) or one run's environment (`JIG__DRIVE__CODEX_PASS_ARGS`), such as `[--dangerously-bypass-hook-trust]`, which lets an unattended `codex exec` run the hooks its Codex home loads without a person approving them. The words go after `codex exec` (after the bypass `drive.codex_bypass` adds) and before the prompt: an arm from a Codex session writes them into the pass command, the dispatcher records them on the launch record and every Codex pass it launches carries them, and `drive.ts` adds them to a Codex pass command with no arguments of its own, keeping one that carries its own as written. The driver log's `pass args:` line names the words and their source. It follows `drive.pass_args`'s rules: a repository's file that sets it stops the drive naming the field, and it refuses the words Codex would read as the model (`-m`, `--model`, `-c model=…`), the prompt or a subcommand, the bypass, and a list that ends in an option without its value. `drive.pass_args` stays Claude Code's, and `--pass-args ''` now also keeps `drive.codex_pass_args` out of a Codex drive. The audit warns about a user file that sets it to a value a drive would stop on. See [a host's opt-in to bypass](../plugin/CONFIGURATION.md#a-hosts-opt-in-to-bypass): the flag skips Codex's review of every hook source, so vet the hooks your Codex home loads first.

### Fixed

- Codex drive arguments now reject the `--yolo` bypass alias, preserve an already recorded command when current settings cannot be read, and report attached sandbox options accurately. **Consumer action:** none.
