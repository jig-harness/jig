---
release: minor
---

The dispatch dashboard can also listen on a private Unix socket for a private-network front to target.

### Added

- `dashboard.socket` in the machine's dispatch file names an absolute path. The reader then also listens there, on a socket created mode 0600 so only its own user and root can open it, with the same read routes and the same `405` to every request that is not a read as its address, and no token to carry. A front points at it with `tailscale serve --bg --https=8443 unix:<path>`; [phone-access.md](../plugin/phone-access.md#a-private-socket-for-the-front) says how, and holds the probe a person runs to see what the front adds to a request. Changing the setting restarts the installed reader.
- `jig dispatch dashboard --status` prints a `socket:` and a `funnel:` line and now fails when the configured socket is missing, is not mode 0600 and the reader's own, or does not answer, and when Tailscale Funnel publishes a route to the socket or the dashboard's port. A Funnel for another service is not named.
