---
release: patch
---

### Changed

- The `jig:converged` label is created green and `jig:parked` red, so a pull request ready for a person to merge, or stopped on something only a person settles, stands out from one the dispatcher still drives. A repository that already has these labels keeps their colors until someone changes them (`gh label edit jig:converged --color 0e8a16`, `gh label edit jig:parked --color d93f0b`).
