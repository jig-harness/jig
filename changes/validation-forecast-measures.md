---
release: patch
---

### Fixed

- The dispatcher's validation forecast (`load.validation`) no longer holds every pickup on an idle host. Runs at once is now the most runs that held the test lock together, which is what its admission allowed, instead of the holders counted only while a run waited. Runs per pass is now the median over finished passes, those that made no run included and never under one, measured per repository; a repository whose lock records no samples is charged every repository's median rather than its passes reading as many runs each. **Consumer action:** none.
