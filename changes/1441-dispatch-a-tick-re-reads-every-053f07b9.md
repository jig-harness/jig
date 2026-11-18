---
release: patch
---

### Changed

- Dispatch reads open pull requests' checks, threads and heads every tick.
  Between full repository reads it revalidates comments when it needs them,
  so unchanged comment pages use no GitHub primary rate-limit points.
