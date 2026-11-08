---
release: minor
---

### Added

- `jig send drive@<owner>/<name>#<PR> rearm` requests another attempt for a
  stopped drive on an admitted account in its existing worktree. Running
  drives and stops recorded by a person are refused.

### Fixed

- The dispatcher gives a drive stopped on an unclean worktree (exit `12`)
  one recovery pass per head in the same tree, with instructions to settle
  its edits. A repeated exit `12` waits for a person and names the `rearm`
  command, with a manual drive alternative when dispatch labels are disabled.
- Rearm requests remain reserved across hosts until their label removal is
  acknowledged, including after a lost runtime receipt or launch-record
  retention. An explicit request can retry an ended admission refusal or a no-cause
  stop whose automatic recovery allowance is spent. A missing original
  exit-12 tree produces a person notification instead of repeated launch waits.
  Every acknowledgment leaves requests pending unless the process probe and
  forge call can settle before the time reserved for the tick receipt.
