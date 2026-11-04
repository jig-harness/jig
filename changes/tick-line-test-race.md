---
release: patch
---

### Fixed

- The dispatcher's test of a tick whose dashboard line cannot be written no
  longer fails now and then with a locked state database: it waits for the
  first tick's drive to record its exit before it removes the line's table.
