---
release: minor
---

### Added

- A finding's `kind` can be `unhelpful-content`: instruction text that cost
  context without helping. `/jig:reflect` accepts it and the stores keep it
  like the other kinds. **Breaking**: a machine on an earlier plugin version
  cannot read a shared store once it holds such a finding, so update every
  machine that shares a store first.
- The reflection store conformance suite checks that `list` is exhaustive: it
  appends a bulk of events (250 by default, `--bulk` to change it) under a
  change each and as many again under one change, with every kind of finding,
  and requires every event the store holds back, with and without a `since`,
  once and byte for byte. A store whose listing is capped or paged below the
  bulk now fails the suite.

### Changed

- `/jig:reflect` tells the agent that the classes it names a finding from are
  the store's complete list after a successful read, so a class missing from
  it does not exist.
- The [reflection stores design](../design/reflection.md) states what every
  store holds to: an exhaustive `list` and the kinds of finding.
