---
release: minor
---

### Added

- `jig dispatch dashboard --access` prints the address of a private-network
  front, and a QR code of it, for opening the dashboard from a phone. Name the
  front's token-free HTTPS address as the new `dashboard.front` setting in the
  machine's dispatch file (accepted only with `require_token: false`, and
  never with a user name, password, query or fragment; it is printed as
  configured, so it must carry no token in its path either). `--access` then
  prints that address as text and, on a terminal wide enough to draw it, a QR
  code of the same address beneath it, black on white in colors it sets
  itself, or in plain characters under `NO_COLOR`. The code carries no token:
  the front still signs the viewer in. Without a front, `--access` prints the private URL as
  before, draws no code for it, and says on standard error how to set one up.
  The QR code is drawn by the plugin itself, with no program to install. See
  [CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)
  and [the phone-access guide](../plugin/phone-access.md).
