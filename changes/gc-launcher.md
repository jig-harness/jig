---
release: patch
---

### Fixed

- The scheduled `jig gc` job no longer stores the path of the plugin release that installed it, which a plugin update leaves behind. The job runs a small launcher that `jig gc install` keeps under `~/.local/state/jig/gc/launcher/`; at each run it asks `claude plugin list --json` (or `codex plugin list --json`) for the installed plugin and runs that copy, so an update reaches the job without reinstalling. Run `jig gc install --repo <repository> --yes` once to replace a job written by an earlier release.
- `jig gc install --uninstall` for one repository, while others remain, now changes only the machine entry and leaves the scheduled job as it is.
- A scheduled `jig gc` run that stalls is now stopped: the launcher ends the collector after the heavy-run lock's wait (`LOCK_TIMEOUT`, which install now carries into the job) and two hours more, and when the scheduler stops the launcher; a stopped run reports failure. An agent tool that does not answer the launcher's plugin lookup within 30 seconds, or prints more than 4 MiB, is killed with every process it started and the run fails; so is one still answering when the scheduler stops the launcher.
