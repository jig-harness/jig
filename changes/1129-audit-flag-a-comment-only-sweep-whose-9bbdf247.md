---
release: patch
---

### Fixed

- The audit now flags comment-only scheduled issue sweeps that omit `--position <file>`, explaining that issues past the read cap are never reached and that the position file must be kept between runs: a workflow counts only when a plain `actions/cache` step for that file, keyed to the run with a restore prefix, is followed by the sweep as the job's last step, run from the workspace root.
