---
release: patch
---

### Changed

- **Other hosts see a launch's end when it ends, not a tick later.** When a dispatched drive or follow-up pass exits, the wrapper that ran it writes the launch's end onto the shared claim its host made for it on the pull request (a drive's launch claim, a follow-up's marker with its answer), so a host dispatching the same repository reads the end at its next run instead of after the launching host's next run. A write the forge refuses is one line on the wrapper's output, and the launching host's next `--apply` run writes the end as before, as it does for a wrapper stopped before its write; the wrapper's exit code stays the stage's ([plugin/README.md](../plugin/README.md#the-dispatcher), [plugin/RECORDS.md](../plugin/RECORDS.md#on-the-forge-and-the-tracker)).
