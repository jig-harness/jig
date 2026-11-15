---
release: patch
---

### Changed

- The verification record in `plugin/phone-access.md` now holds the results
  of the Tailscale Serve front's checks: the front and its version, tokenless
  HTTPS access, the `Host` allowlist and installing the page as an app on a
  phone. The QR code, copy, clipboard-refusal, refusal, forged-header, Serve
  route and reverse-proxy rows are still not run.
