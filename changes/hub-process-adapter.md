---
release: minor
---

### Added

- `jig hub serve` runs the optional hub on Bun: the host protocol's
  listener under `/v1/` on loopback and private-network addresses only, a
  webhook listener that serves `/webhooks/<source>` and answers 404 to
  every other path, and the feed on a Unix socket or on loopback with the
  front's secret. Its scheduled jobs keep their next run in the hub's
  database and run in a worker thread with its own connection, so a long
  run never delays a webhook's acknowledgement. The hub's settings file is
  described in [the hub's README](../plugin/hub/README.md).
  **Consumer action:** none.
- `jig install hub` installs `jig hub serve` as a resident job of the
  hub's own OS user (`jig-hub` by default), restarted when it stops and
  when the installed plugin copy changes, one at a time, and refuses root,
  another user, the dispatcher's user and a user whose scheduler cannot be
  read to tell. Where podman or docker is installed it builds the hub's
  container image locally from the installed release, never pushing it,
  and runs the hub in it with its settings mounted read-only. A bare
  `jig install` never includes the hub, and only
  `jig uninstall hub --machine` removes it, stopping the running hub.
  **Consumer action:** none.
- `jig doctor hub` checks the hub's OS user, the modes of its settings file
  (0600) and database directory (0700), the interfaces its listeners
  bind and the feed socket's directory, and fails when another user can
  read either file.
  **Consumer action:** none.
