---
release: minor
---

### Fixed

- `jig gc`'s `scratch` kind no longer gives up on a test-fixture registry
  larger than one bounded read ("Fixture inventory is malformed or exceeded
  its bounded scan"). It reads the registry in bounded pages, resuming the
  next run where the last stopped, and reports a malformed registration as
  its own receipt line instead of failing the whole inventory.
- A test-fixture registration whose roots are all gone is now retired by a
  collecting run once every registered process has exited, under the same
  exclusive scratch admission, and the receipt names each registration it
  retired. Before, such a registration stayed for good, and the registry grew
  without bound.
