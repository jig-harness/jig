---
release: patch
---

### Fixed

- drive-pr no longer re-runs a CI job that ran past its time limit (`timeout-minutes`) and then parks it as cancelled CI, recommending another re-run that stops at the same limit. The forge reports such a job as cancelled, so drive-pr now reads the annotation the runner leaves on its check run. A job the runner stopped at its limit is a timed-out job. drive-pr repairs it as a failing check, from the same CI-repair budget, and tells the repair pass the job, its limit and how long it ran. A cancellation it cannot attribute to a time limit keeps the cancelled-CI recovery. **Consumer action:** none.
