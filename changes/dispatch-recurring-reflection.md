---
release: minor
---

### Added

- The dispatcher records each recurring class as a reflection finding. Where
  reflection is on for a repository (a `reflection` section in any
  configuration layer, the repository's own read from its default branch), a
  `jig dispatch --apply` tick on the host that owns the repository appends,
  after its launches, one finding per recurring class per week: an error
  about the dispatcher as a Jig tool, its class `dispatch-recurring-<class>`
  (such as `dispatch-recurring-gates-failed`), with the repository, the
  stage, the days, the row count, the reasons the rows give most often and
  the dashboard filter that shows them. Its id is derived from the
  repository, the stage, the class and the week, so later ticks that week
  record nothing new and each week the class still recurs counts toward its
  escalation in `/jig:review-reflections` run in Jig. The append runs under
  `reflection.timeout_sec`, cut to the time the tick has left, in batches, with
  the store command run in the repository's checkout; a store that fails or does not answer is named on
  the receipt, the tick's exit status stays as it was, and the next tick
  sends the same finding again. A tick without `--apply` lists what it would
  record. It records only: it changes no cap, expectation or nudge
  ([the plugin's README](../plugin/README.md#the-dispatcher)).

### Changed

- The dashboard's recurring classes count a drive stopped for a person, and
  every other event row that carries a class, beside the rows of ended
  sessions, and are counted per stage: a class recurs on one stage of a
  repository on at least three of the last seven host days. Each row of the
  list names its stage, and its button filters the log to that stage.
