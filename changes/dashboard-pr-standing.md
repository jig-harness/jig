---
release: minor
---

The dispatch dashboard says where each pull request stands, can run without a token behind a front on the host, and stacks its panels in one column.

### Added

- Each pull request on the dashboard is an icon in the colour of its state: driving, following up after the merge, waiting, needs a person, queued, held, merged or closed. Hovering or tapping the pull request opens its state, round, unresolved thread count, how long it has waited and the dispatcher's own reason. The state comes from the newest tick's line, so a dashboard served without a GitHub login still shows it.
- `dashboard.require_token: false` in the machine file serves the dashboard with no token. It is accepted only with a loopback `dashboard.listen`, so the only way in from another machine is a front on the host, such as Tailscale Serve, that authenticates the person first. A tokenless dashboard answers only `localhost`, `127.0.0.0/8` and `::1` as the request's `Host`, plus the names `dashboard.allowed_hosts` lists for the front, and refuses any other with 403. See [the machine's dispatch file](../plugin/CONFIGURATION.md).

### Changed

- The dashboard's Now view, running slots and legend no longer sit side by side at any width: one column keeps vertical scrolling the same on a phone and a desktop.

### Fixed

- Every pull request on a dashboard whose server could not call the forge showed "Unknown" with no popover content; its icon now opens the state the line holds.
