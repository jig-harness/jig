---
release: minor
---

### Fixed

- A drive ledger at version 1 or 2 whose parked question names an
  [Enterprise Managed User](../GLOSSARY.md) login (`mona_acme`) as its person
  now reads as damaged: Jig writes such a ledger at version 3 only, so an
  earlier version naming one comes from no writer that follows the format.
  Every path that writes a ledger, a person's stop included, now takes its
  version from one choice, which keeps the version it read and raises it
  only for a stop or a managed recipient.
- **Breaking:** The [hidden comment markers](../plugin/protocol/comment-markers.md)
  protocol is now version 3. Its drive-ledger schema has one alternative per
  group of ledger versions and takes a managed login as a parked question's
  person only at ledger version 3. The chapter now also lists the re-arm
  request's schema. The version 2 data file and schema addresses on the site
  are withdrawn. **Consumer action:** required at machine. A program that
  loads the comment-markers schemas or data file from the site moves to the
  version 3 addresses, or loads its own copy of version 2 as
  [Earlier versions are withdrawn](../plugin/protocol/README.md#earlier-versions-are-withdrawn)
  says. **Detect:** `text:protocol/comment-markers/v2`.
