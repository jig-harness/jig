---
release: minor
---

A repository's `ci.log_command` runs the program the default branch holds, not the copy in the pull request it repairs.

### Security

- `ci.log_command`'s text was already read from the default branch, but it ran with the pull request's checkout as its working directory, so a script the repository keeps (`bun scripts/ci-log.ts`) ran as the pull request's author had edited it. It now runs in a temporary copy of the default branch's files, made from the same commit its text was read from without touching the repository's index, working tree or branches, and removed when the read ends. A copy that cannot be made fails the read; the command never falls back to the working tree. The copy is made under `$JIG_HOME/tmp`, from the commit's own attributes and without any hook of the working tree, and one copy serves every failing status of one read.

### Changed

- **Breaking:** the copy holds tracked files only. A `ci.log_command` that relied on something installed or generated in the working tree (`node_modules`, build output) no longer finds it, and the copy is not a git checkout, so `git` and `gh` do not find the repository from its working directory. **Consumer action:** advised at configuration. Make the command self-contained, or have it install what it needs and give `gh` `-R <owner>/<repo>`; a script that imports only Bun's built-ins and files in the repository needs nothing. **Detect:** `config:ci.log_command`.
