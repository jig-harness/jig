---
release: minor
---

### Added

- `jig --help`, `jig help <command>` and `--help` after any command (`jig gc --help`, `jig dispatch install --help`) print help generated from the command line's own definitions, with a plain description of every option; `jig completion bash`, `zsh`, `fish`, `pwsh` or `nu` prints a shell completion script for the `jig` command. The command line is parsed with [Optique](https://optique.dev), vendored in the plugin (`shared/vendor/optique.mjs`, MIT License). Every existing form of `jig gc` and `jig dispatch`, and the jobs `install` wrote, keeps its meaning and exit code: there is nothing a consumer must change.

### Changed

- A refused `jig gc` or `jig dispatch` command line prints Optique's error with the command's usage on standard error, still with exit 2. A switch given twice (`jig dispatch --json --json`) is now refused there as it already was for `jig gc`, and `jig --help` exits 0 with the help instead of 2.
