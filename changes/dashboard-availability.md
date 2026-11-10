---
release: minor
---

### Added

- The dispatch dashboard can run through its own retry timer on Linux with systemd user lingering or cron, independently of the dispatcher and without Orca. Installation, status, explicit private URL access and uninstall commands keep one read-only reader available across failures, logout, reboot and installed-copy updates; service logs do not print its access token.
