---
release: patch
---

### Fixed

- A drive no longer parks `cancelled-ci` on the cancellations its own re-arm causes. Flipping the drive's state labels starts the workflows that listen for label events, and under a concurrency group with `cancel-in-progress` those runs cancel each other, and any run in flight on the head (a person's re-run of the parked run included), within seconds. Cancelled-run recovery now re-runs a cancellation a label write caused outside the head's once-per-head re-run, once per run attempt and claimed durably before the request, and waits for its result. Such a cancellation is a first attempt created within 30 seconds after a label other than the CI hold's was added or removed, or a run of its workflow whose latest attempt was still in flight when it arrived. A label-caused re-run still cancelled a minute after its request, or one that may not be replayed under the CI hold, counts against the head's budget as before.
