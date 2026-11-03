---
release: minor
---

### Changed

- `jig gc`'s `worktrees` kind no longer treats a detected package manager's
  dependency directory (such as `node_modules/`, wherever it sits in the
  tree) as local state that vetoes collection: it is rebuildable from the root
  `package.json` and tracked lockfile, so a worktree is judged on the rest of its
  evidence instead. Any other ignored path (`.env`, `.context/`, a build
  output directory) still vetoes collection exactly as before, and the
  receipt now lists the ignored paths it set aside as rebuildable.
