---
release: patch
---

### Fixed

- On Windows, `jig gc` no longer fails every run with `EPERM` when it writes a
  collection receipt. Windows refuses to flush a directory, so there a
  receipt's directory entry is not flushed: a power loss just after a receipt
  is written or updated can lose that write.
- On Windows, a configured shell command (`code_stats.classify_command`,
  `resolve_conflicts` obligation commands, the changelog's `after_version`)
  reaches `cmd.exe` as written, so a quoted program path such as
  `"C:\Program Files\tool.exe" args` runs instead of failing as an unknown
  command.
- On Windows, a repository reached through an 8.3 short path (such as
  `C:\Users\RUNNER~1\…`) is recognized as the repository git reports: the
  migration-immutability and interface-surface gates, the deferral check's
  `--config` and `--states`, `/jig:reflect`'s journal check, `/jig:decide`'s
  other-repository clones and `resolve-conflicts`' `record.ts` no longer
  call a path inside it outside.
- `resolve-conflicts` treats a staged link to an absolute Windows path
  (`C:/…`) as leaving the repository, as it treats one to `/…`.
- On Windows, the audit's configuration fit reads a gate script's executable
  bit from the git index, so a shell script the index does not mark
  executable is suggested as `bash <path>`, as on other platforms, rather
  than as `./<path>`.
- The audit's label-taxonomy finding names the configured file with forward
  slashes on every platform, and the audit reads the taxonomy the way
  `/jig:file-issue` does, so a Windows network share path
  (`\\server\share\…`) is checked rather than reported unreadable.
- The audit's configuration fit reads a file a configured command names the
  way the shell running the command reaches it, following a link before a
  `..`, and warns that a fresh clone lacks it unless both the file it
  reaches and every link on the way are tracked.
- A relative `JIG_TRACE_FILE` now records the spans of the process that set
  it on Windows too.
- The design-brief renderer waits for Chromium's debugging endpoint while
  Windows still holds the file open, instead of failing with `EBUSY`.
