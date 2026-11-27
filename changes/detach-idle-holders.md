---
release: minor
---

### Added

- The dispatcher can free a pull request's branch from a leftover checkout
  without asking a person, where the host opts in through two keys in the
  machine file, `~/.jig/dispatch.yaml`. Both default to `false`. With
  `detach_idle_holders`, a workspace open also detaches a checkout the
  workspace runtime does not list when no process, drive or session uses it
  and every commit it holds is on the remote. It does this even when the
  checkout's tree holds uncommitted changes, and those changes stay in the
  tree. With `rescue_unpushed` as well, the open also detaches a checkout
  whose commits the remote lacks. It first keeps those commits on a
  [rescue branch](../GLOSSARY.md), a local branch
  `jig-rescue/<tree>-<time>` that nothing pushes or collects, then moves the
  branch back to the remote's copy so the open can check it out. The launch's receipt and a
  comment on the pull request name the rescue branch and its clone. A rescue
  that fails leaves the checkout as it was, and a person is asked as before.
  A checkout that a process, a drive or a session uses is never touched.
  The settings are described in
  [CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file).
