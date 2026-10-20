---
release: minor
---

### Added

- Git Bash requirements and Windows validation limits for do-item and drive-pr, with explicit Bun script commands and native process-control guidance. PowerShell support and the complete Windows pickup, pull request, round and stop smoke remain pending.

### Fixed

- Windows process runners resolve executable extensions and launch batch shims with arguments preserved, allowing npm-installed agent commands to start. A bare command name is searched in the working directory before the executable search path, as native Windows spawning does, and only executable and batch extensions are tried. Batch arguments containing line breaks or null bytes, and batch launches longer than cmd.exe's 8,191-character command line, are refused; pass such content through a file or standard input.
- fix-ci runs setup commands under sh on Windows so POSIX shell syntax works with Git for Windows.
