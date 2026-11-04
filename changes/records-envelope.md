---
release: minor
---

### Added

- Every record the plugin keeps is now listed in one place,
  [plugin/RECORDS.md](../plugin/RECORDS.md): on the machine, in the working
  tree, on the forge and on the tracker, each with where it lives, its
  format, who writes it and what keeps two writers apart. Behind it is a
  [records registry](../GLOSSARY.md) the plugin's own checks keep complete.
- A [record envelope](../GLOSSARY.md): the fields a record carries to say
  what it is, its version, what it is about, who wrote it and when. The
  drive ledger on a pull request and the dispatcher's follow-up marker carry
  it first.

### Changed

- The drive ledger's data now carries the record envelope beside its own
  fields. A ledger written by an earlier version still reads, and an
  earlier version still reads the new ledger. On the forge the writer's
  host and boot are written as digests, so a pull request comment names no
  machine.
- The follow-up marker's record now sits in a hidden block from its second
  line, with a line a person reads after it. A marker written by an earlier
  version still reads. An earlier version reads the new form as a marker it
  cannot read, so it plans no follow-up for that pull request and reports
  it: update every machine that dispatches a repository together.
