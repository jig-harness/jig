---
release: minor
---

### Changed

- M13's job timeouts are generous and capped. Every job has a timeout of about
  two to three times its slowest healthy run, because its work is to stop a
  hang, not to police a slow day; the workflow-convention lint's `job-timeout`
  rule now also fails a job above 60 minutes (a job that cannot be sharded
  carries a reasoned exception), where it accepted anything below the
  provider's six-hour default. The module, the copyable pipeline-economy page
  and the M1 workflow skeleton say the same.
- M14 enforces a tight tier budget on the suite's own command or step; the
  job timeout around it is M13's generous backstop and enforces a budget
  alone only when the budget is that loose.
- **Breaking** for a repository audited at Strict on M13: `/jig:audit` adds
  `M13/job-timeout-ceiling-linted`, which requires the CI-configuration lint
  to fail a job timeout written as a number above an hour unless a reasoned
  exception covers that job. A lint that accepts any value below the
  provider's default does not meet it; the comparison with an earlier audit
  reports it as added by Jig, not as a regression. To meet it, enforce the
  ceiling in the lint (M13's reference lint does) and register a reasoned
  exception for each job that cannot be sharded below an hour.
- `/jig:audit`: `M14/tier-budgets-enforced` observes that the bound
  enforcing a declared tier budget is no looser than it; a job timeout well
  above the budget is a backstop, not its enforcement.
