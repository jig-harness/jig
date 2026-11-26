---
release: patch
---

### Fixed

- Converged pull requests that the board read places in Needs you (`place: "needs-you"`, `lane: null` in `line.ready`, such as pull requests blocked by an unread branch-protection rule, converged drafts, re-applied hold labels, post-convergence review threads or failing checks) now appear on the dispatch dashboard's Needs you tab under their mapped act group with their board reason, copyable `jig ask` command and folded Ready conditions, and are included in the Needs you tab count, answer band, command palette and pull request standing popover instead of disappearing from both Merge and Needs you. **Consumer action:** none.
