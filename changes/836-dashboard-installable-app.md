---
release: minor
---

The dispatch dashboard can be installed on a phone as an app.

### Added

- The dashboard's page names a web app manifest (`/manifest.webmanifest`) and
  its icons (`/icons/*`), and sets a theme colour for each colour scheme, so
  Chrome on Android offers **Install app** for it. The installed app opens in
  its own window at the dashboard's root address, with no token in any address.
  A dashboard that asks for a token refuses the manifest with every other
  request without the token, so only a dashboard served without a token, behind
  an HTTPS front, is offered for install. The
  [phone access guide](../plugin/phone-access.md#install-it-as-an-app) has the
  steps and the check.
