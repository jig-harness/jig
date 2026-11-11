---
release: minor
---

### Added

- A guide for opening the dispatch dashboard from a phone
  ([plugin/phone-access.md](https://github.com/jig-harness/jig/blob/main/plugin/phone-access.md)):
  a private HTTPS address through Tailscale Serve, or through an
  authenticated reverse proxy without Tailscale or Orca, with no token in the
  address; the private-HTTP fallback and what it costs; the owner-only
  boundary; how to undo it; and a verification record. The record's rows are
  marked not yet run until a person runs them on a phone.
