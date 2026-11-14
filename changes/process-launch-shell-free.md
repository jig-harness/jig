---
release: patch
---

### Changed

- The shared process launchers in `plugin/shared` document, beside each
  launch, why no shell reads a path or argument: the git-guarded launcher and
  the cross-platform launcher pass an argument vector. On Windows, cmd.exe
  reads a `.cmd` or `.bat` launcher, escaped, and a command line that names
  `cmd.exe /s /c` itself, as written. New tests hold this
  for shell syntax in an argument. How a command runs does not change.
  **Consumer action:** none.
