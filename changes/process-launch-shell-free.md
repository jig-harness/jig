---
release: patch
---

### Changed

- The shared process launchers in `plugin/shared` document, beside each
  launch, why no shell reads a path or argument: the git-guarded launcher and
  the cross-platform launcher pass an argument vector, and only a Windows
  `.cmd` or `.bat` launcher goes through cmd.exe, escaped. New tests hold this
  for shell syntax in an argument. How a command runs does not change.
  **Consumer action:** none.
