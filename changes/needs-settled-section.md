---
release: minor
---

The dispatch dashboard's Needs you view now shows what left it: who settled each need and how.

### Added

- **Settled recently** on the dispatch dashboard's Needs you view: below the open cards, a section folded to one line with its count lists each need that left the line in the last 24 hours, newest first. Each entry gives the target and its link, the question or act it carried, when it left, by whom (the person's login, a rule of the tick, the steward's record, or no one because its facts changed), how, and a link to its History rows. An answer a station held or refused shows with its reason while its card stays open. **Consumer action:** none.
- `jig ask --settled` (with `--json` and `--person`) lists the same entries for an agent or the panel's inbox, from the newest tick's line and with no forge or tracker call. **Consumer action:** none.
- The tick records every need that leaves the line in a new `need_leaves` table, whatever its notify stage does, and keeps the rows for a week. A need that leaves and returns is two entries. **Consumer action:** none.
