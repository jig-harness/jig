---
release: minor
---

### Changed

- `jig dispatch --apply` now starts a pickup on Orca. Each item it picks
  up runs as a headless `do-item` pass, started by the same wrapper as a
  follow-up's pass and bound to an admitted account through that account's
  configuration directory. The identity is checked before the pass starts.
  The pass keeps the agent's own model and effort. Its prompt carries the
  line `route: rules`, on which `do-item` forwards the item's route to the
  implementer it delegates to, where the repository declares `routing`. On
  a Codex account a pickup starts only on a host that set
  `drive.codex_bypass`. Orca still cannot bind an interactive session to
  an account, so that refusal now covers interactive launches only, and
  none is started.

### Added

- `dispatch.pickup_deadline` (3 hours by default): the deadline a pickup's
  pass runs under. The wrapper stops the pass when it runs past it.
- A pickup pass that cannot finish without a person does the work that
  does not depend on the answer, then stops on a `Question:` line. The
  tick notifies that question as a need (`pickup-question`) on the line,
  in `jig ask --waiting` and on the dashboard. It does not start the item
  again until the item leaves the dispatch states and comes back.
  `do-item`'s `SKILL.md` describes this unattended path under
  "Dispatched passes".
