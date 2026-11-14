---
release: patch
---

### Fixed

- Headless dispatch stages now run under a supervisor that stops the stage
  when its launch wrapper dies. Durable supervisor and child identities keep
  the account slot occupied while work survives, while a launch handoff is
  unresolved, or while cleanup cannot be confirmed. Interrupted drives keep
  their slots because their detached passes need a separate cleanup witness.
  The dispatch database upgrades automatically; older plugin copies refuse
  the upgraded database because they cannot account for these identities. Windows retains its
  existing limits for observing cooperative process trees.
