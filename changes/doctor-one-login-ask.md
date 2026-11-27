---
release: patch
---

The drive doctor asks its forge client who it is once per run, and the dispatcher's line now shows a caller whose credentials never succeed.

### Fixed

- `drives.ts --doctor` still sent a `GET /user` and an issue-comment read for every drive whose state carried an unreleased CI hold, on every run, all failing when its forge client had no login. The diagnosis of every CI hold and the recovery of every leftover record now share one question per run, whatever the run was asked to do. A client that names no login makes that one failing call, prints one line on standard error and nothing on standard output, and exits `4`, leaving the records for a later run; a run that needs no forge read asks nothing. `drives-read-only.ts` and `jig ask`, which read the doctor, report the same reason. **Consumer action:** advised at machine, instructions. A job that reads `--doctor`'s exit code treats `4` as the client naming no login, not as a finding. To confirm after upgrading, `jig budget --hours 3 --json` shows the failing `GET /user` and issue-comment reads of `skill:drives.ts` falling to about one per run on a host whose client has no login; before the change they were about 58 of each per run.
- The `calls-failing` host need never appeared for a caller that had one working credential beside its failing ones, because the working one hid the rest. Each credential is now judged by its own calls: a caller with credentials whose every call was refused as `unauthorized` or `invalid`, at least 20 calls in all, shows on the line.
