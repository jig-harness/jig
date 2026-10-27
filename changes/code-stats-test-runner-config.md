---
release: minor
---

### Added

- `/jig:code-stats` reads the repository's test-runner configuration, so a
  repository whose tests only its test runner names counts them as tests
  with no `code_stats` section: jest's `testMatch`, `testRegex` and `roots`,
  vitest's `test.include` and `test.exclude`, pytest's `testpaths` and
  `python_files`, Gradle's `test` source set folders and Maven's
  `testSourceDirectory`. The files are read as text and never run; a
  configuration that exists only when it runs is reported as
  `unreadable: <path> (<why>)` and nothing is claimed from it. The layer
  sits between built-in detection and the `code_stats` configuration,
  `--explain` names the reader, file and key behind a test it found, and
  `--json` lists the configurations read and those that could not be under
  `testRunners`
  ([README](../plugin/skills/code-stats/README.md#test-runner-configuration)).
