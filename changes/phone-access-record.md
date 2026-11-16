---
release: patch
---

### Changed

- The verification record in `plugin/phone-access.md` now holds the results
  of the Tailscale Serve front's checks: the front and its version, tokenless
  HTTPS access, the `Host` allowlist, the QR code scanned on a phone and, in
  part, installing the page as an app on a phone. The phone browser's product
  and version, the installed app's behaviour, copy, clipboard-refusal, refusal,
  forged-header, Serve route and reverse-proxy rows are still not run.
