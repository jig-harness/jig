---
release: minor
---

### Added

- Declared priorities, reported only. A repository can state its objectives
  in `.config/priorities.yaml` (format `priorities/v1`: each objective's
  class, purpose, end state, owner, the epics or labels it covers and an
  optional share), checked by a schema that refuses unknown fields,
  duplicate ids, empty selectors, negative values and shares above one. A
  host sets how the weighted lanes share starts in its own
  `$JIG_HOME/weights.local.yaml` (`lanes:`; defaults `core` 50, `tactical`
  25, `peripheral` 10, `bug-other` 15), read again on every tick and failing
  closed for what it cannot read. Both files are optional
  ([CONFIGURATION.md § Priorities](../plugin/CONFIGURATION.md#priorities)).
  **Consumer action:** none.
- The dispatcher ranks a shortlist from the record, the weights and a
  tracker snapshot with a pure, reproducible ranker: Urgent issues first,
  then High bugs, then the weighted lanes by fair allocation, with the
  peripheral lane's floor carried across a week boundary. An epic's rank
  reaches its children, and a disagreement between an epic's position and an
  issue's own Priority is reported, never edited. The tick report and
  `jig dispatch` show the shortlist, each lane's share and the floor owed
  beside what was actually started. What the dispatcher starts does not
  change.
- Each successful pickup claim records one allocation charge with its lane,
  its owner and the weights read; the first tick of a week records the
  completed week's counters and the next week's opening debt. Both are new
  tables in the dispatcher's state database, listed in
  [plugin/RECORDS.md](../plugin/RECORDS.md).
- The `priorities` skill validates a priorities record and the weights file,
  prepares a record change as a pull request plan or a weights change as a
  local diff, shows how the dispatcher's shortlist would move, and asks
  `work-batch`'s eligibility mode which issues may be batched. It never
  starts work or edits a tracker's Priority.
