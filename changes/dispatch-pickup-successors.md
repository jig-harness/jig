---
release: patch
---

### Fixed

- The dispatcher uses indexes to find later pickups of an item, including batch members, when recording a dependency wait.
- Busy worktree notices in the dashboard and `jig ask`, including the drive and follow-up answers, direct operators to the checkout holding the branch.
- A pickup record that parses but is not a launch record also holds back a dependency wait, as an unparseable one does.
