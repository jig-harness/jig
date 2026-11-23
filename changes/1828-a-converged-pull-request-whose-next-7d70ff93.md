---
release: patch
---

### Fixed

- Refresh the verified head of a merge-ready pull request after a clean base
  merge and passing required checks, without running new review rounds.
  The refresh rechecks live pull request and ledger state before deleting
  announcements, so a concurrent update cannot remove a valid announcement.
  Conflicts still get a re-drive at each pair of heads and go to a person if
  the re-drive leaves the conflict in place. **Consumer action:** none.
- Show the person who investigates when a drive uses its round budget in
  the outcome log, dashboard and `jig ask`. **Consumer action:** none.
