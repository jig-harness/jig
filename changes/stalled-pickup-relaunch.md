---
release: minor
---

### Added

- The dispatcher relaunches a stalled pickup once in its own tree to push
  and record its work. A claimed item idle past `dispatch.stalled_after`
  whose latest headless pickup left unpushed commits or uncommitted edits in
  its tree, or recorded no result, is started again in that same workspace,
  never a fresh one, with a fixed prompt to commit and push the work and
  record the pickup's result, making no second claim. It happens once per
  item and head: a second stall at the same head, a tree no open workspace
  on the host holds, or a batch's pickup is still raised to a person. A pass
  whose result the host could not write takes the same relaunch once the
  host's health check passes, instead of asking a person to settle or
  release the item. `dispatch.stalled_relaunch` in `.config/jig.yaml` is
  `finish-once` by default; `never` turns it off.
- Every dispatched pickup's prompt, and `do-item`'s dispatched-pass rules,
  now tell the pass to push its branch and record its result before it
  ends, whatever ends it.
