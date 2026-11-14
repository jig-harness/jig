---
release: patch
---

### Changed

- The shared process launchers in `plugin/shared` document, beside each
  launch, that by default they pass an argument vector, so no shell reads a
  path or argument. A caller that sets `shell: true` or names a shell itself
  (the configured POSIX commands run as `sh -c`, a Windows command as
  `cmd.exe /c`) opts into that shell's interpretation. On Windows, cmd.exe
  also reads a `.cmd` or `.bat` launcher, escaped. New tests hold the default
  for shell syntax in an argument. How a command runs does not change.
  **Consumer action:** none.
