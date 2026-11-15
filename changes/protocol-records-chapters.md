---
release: minor
---

### Added

- Two more chapters of the [Jig Protocol](../GLOSSARY.md), for a program
  that reads Jig's records on the forge and the tracker without reading its
  code, each with its values as JSON beside it in `protocol/data/`.
  [Hidden comment markers on the forge and the tracker](../plugin/protocol/comment-markers.md)
  lists every hidden marker Jig writes or reads in comments and bodies, with
  the record it marks, its version, its key's shape, who writes it and what
  it means, and the fields of the record envelope.
  [The follow-up claim and its result](../plugin/protocol/followup-claim.md)
  gives the follow-up marker's runs, each run's outcomes and the fields of
  its record. Both are generated from the records registry and the code that
  writes and reads the markers, and Jig's build fails when a chapter and the
  code disagree. Every kind in the records registry now says what it means
  to a reader, in a required `meaning`. **Consumer action:** none.
