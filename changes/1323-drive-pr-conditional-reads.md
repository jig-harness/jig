---
release: minor
---

### Changed

- A drive pass re-reads a pull request's REST resources (its issue comments, reviews, review comments, check runs, commit statuses and workflow runs) only when they changed. Within one evaluation, every part of the pass that asks for the same resource shares one reading; across evaluations, each page is asked again with the ETag of its last reading, so an unchanged pull request is answered `304 Not Modified`, which GitHub's primary REST limit does not count. A page added after the last one is still seen, and a failed or unreadable answer falls back to reading the resource whole. Reads that authorize a write, a thread resolve, a CI-green proof or an announcement still read GitHub whole each time. **Consumer action:** none.

### Added

- The cost ledger counts, per operation and caller, how many requests GitHub answered `304 Not Modified`, and `jig budget` shows the count beside each total, so a route's unchanged re-reads show apart from its other requests ([configuration reference](../plugin/CONFIGURATION.md#outbound-cost-reports)). **Consumer action:** none.
