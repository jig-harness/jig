---
release: patch
---

### Fixed

- The scheduled `jig gc` job no longer stores the path of the plugin release that installed it, which a plugin update leaves behind. The job runs a small launcher that `jig gc install` keeps under `~/.local/state/jig/gc/launcher/`; at each run it asks `claude plugin list --json` (or `codex plugin list --json`) for the installed plugin and runs that copy, so an update reaches the job without reinstalling. Run `jig gc install --repo <repository> --yes` once to replace a job written by an earlier release.
