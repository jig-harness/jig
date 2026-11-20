---
release: minor
---

### Fixed

- A dispatched pickup whose push the repository's pre-push hook refused only
  because its wait for the host's test lock ran out no longer stops on a
  question for a person. The `do-item` skill tells that lock-wait timeout
  (the lock's own `could not acquire lock` message, no test having run) from
  a hook that ran and failed, and pushes again after a short, growing pause
  while it has time, never bypassing the hook. A dispatched pass that still
  cannot get through records `jig dispatch result <record> <token> waits --reason test-lock`;
  the dispatcher relaunches the pickup in its own tree to push and carry on,
  holding the relaunch while the host's validation capacity has no room,
  whether or not `load.enforce` is set. After three such waits in a row it
  raises one need for the steward or a person to find why the lock keeps
  running out.
