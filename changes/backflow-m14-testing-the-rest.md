---
release: minor
---

`fix-ci` attributes a test failure on a freshly fetched base before it fixes
anything, and M14 gains the practices around it: the skip tripwire, stale-test
triage, behaviour pins, a runtime canary, one toolchain version source, and
exit-code assertions that print the child's output.

### Added

- M14 skip tripwire
  (`modules/M14-testing-strategy/reference/tests-executed/`): a gate that
  fails a CI job whose suites executed zero tests, counted from the runner's
  JUnit report as the test cases not skipped, per suite where asked; a
  missing or unreadable report, one that is not well-formed XML, or one
  with a suite or case outside its place in the JUnit tree fails closed.
  The report is read by `plugin/shared/junit-report.ts`, a strict XML
  parser that reads the document in order against the XML grammar
  (predefined entities only, line ends normalized, a `DOCTYPE` read by its
  grammar and without an internal subset), shared with
  `fix-ci`'s probe so the two gates cannot read one report differently. Core piece 11 states the rule,
  the mappings give the report flag per runner (Bun, Vitest, Jest, pytest,
  gotestsum, Surefire and others), the template carries it, and the audit
  scores the Standard criterion `M14/provisioned-suites-executed`.
- `fix-ci` stale-test triage: `plugin/skills/fix-ci/scripts/probe-base.ts`
  reproduces a failing check on a freshly fetched base in a throwaway
  worktree (never a stash, never a checkout in the working tree), with the
  repository's install command run there first (`--setup`), and says
  whether the failure is the change's, pre-existing, or undecidable. For a
  test, the verdict is the named case's own result in the JUnit report the
  command writes on the base (`--expect` the test's name, `--junit` the
  report), so another case failing beside a passing one is not read as the
  same failure. An exact case name is read before a partial one, a skipped
  case beside a run one is no answer, and a report already at that path on
  the base is removed before the command runs, so only the report the
  command writes is read; a check with no per-case report counts as pre-existing only
  when the base's output shows the error message CI showed. A fetch, an
  install, a git call, setup or command past its own `--timeout`, a report with no answer for the
  case, or a different failure on the base is no answer. `SKILL.md`'s test-failure step runs it in
  place of the pointer to a procedure the repository was assumed to have.
  M14 core piece 12 states the rule (fix a stale test inline when cheap,
  otherwise delete it with a tracker item recording what it covered;
  regenerate a test only when its premise is obsolete) and links M13's
  unscoped run on the integration branch; the glossary defines *stale test*
  and *fresh-base probe*; the audit scores the Lite criterion
  `M14/stale-test-triage-written`.
- M14 behaviour pins and the runtime canary: every workaround for a defect
  in a dependency has a test beside it that asserts the defective behaviour
  against the real dependency and names the workaround (core piece 13), and
  `modules/M14-testing-strategy/templates/runtime-canary.yml` is a scheduled
  workflow that blocks nothing, runs the suites with pins and the
  integration tier against the runtime's next release, smokes the compiled
  binary, and records the build it used (core piece 14). The mappings give
  the shape of a pin per runner and the next-release channel per runtime;
  the audit scores `M14/dependency-workarounds-pinned` (Standard) and
  `M14/next-release-canary` (Strict).
- M2 one version source
  (`modules/M2-generated-artifact-freshness/reference/toolchain-pins/`): a
  toolchain version is declared in one place, and the gate fails when a pin
  site (a CI setup step, a container build argument, a package-manager
  field, a type package) differs from it. A CI setup step is read from the
  parsed workflow (`step:` with its version input), so a comment is no step
  and a step without its version is caught; every file a structured path
  names must hold the pin, every glob must match a file, and an empty
  version is no version. A setup step that reads the version from a file
  agrees only when that file is the source and the action's own reader,
  which the gate mirrors for `actions/setup-node` and `oven-sh/setup-bun`,
  takes the source's value from it; any other action, and a file the action
  reads in a way the gate does not follow (`package.json`, `mise.toml`),
  sets its version explicitly. Exceptions carry a reason and prune themselves. Jig declares its own pins in `.config/toolchain-pins.yaml`
  and runs the gate as `bun run pins` in the fast gates; the audit scores
  `M2/toolchain-pins-one-source`.
- M14 exit-code assertions that print the child's output: a test that
  asserts a spawned process's exit status asserts it through a helper that
  prints the child's captured output when the assertion fails
  (`lib/test-helpers/expect-spawn-exit.ts`, with `expectSpawnExited` for a
  child whose exit is awaited), since a bare assertion reports
  two numbers and a genuine regression then reads like a process killed
  under load. Core piece 7, the Standard level, the template and AGENTS.md
  state the rule, the mappings give the helper and the lint per ecosystem,
  and the audit scores the Standard criterion
  `M14/spawn-exit-assertions-print-output`. Jig's own lint rule
  `tools/quality/grit/no-bare-exit-code-assertion.grit` flags the bare shape,
  synchronous or awaited, in test files at `warn`, so the ratchet lets its count only fall. Outside
  drive-pr no test asserts either shape the rule matches, and the
  resource-lock suite's own wrappers (an array of awaited exits, a helper's
  returned code) assert through the helper too; a wrapper that renames the
  field is outside what the rule sees. The drive-pr suite keeps 1,002 bare
  assertions to burn down.

### Changed

- `@types/bun` moves to the runtime's version (1.4.3), which the toolchain
  pins gate found a patch behind.
