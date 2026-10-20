# drive-pr consistency checklist

For contributors changing this skill. drive-pr changes more often than any
other part of the drive loop: `SKILL.md`, the `__tests__/drive-pr-*.test.ts` suite,
`references/terminal-states.md` and `scripts/lib/state/**` see the most
churn. Drift between documentation and code across these files is the
recurring defect. When touching this skill, check:

- **State, lock and lease constants stay in sync with their consumers.** These
  values are not duplicated across every file: state shape lives in
  `scripts/lib/state/schema.ts`, lock timing in `scripts/lib/state/lock.ts`,
  lease timing in `scripts/lib/state/lease-model.ts`, and the terminal-state set in
  `scripts/lib/status/terminal-states.ts`, restated by hand in `SKILL.md`,
  `README.md`, `references/terminal-states.md` and `scripts/drive-status.ts`'s
  header. If a change
  touches a state or timeout, verify every actual consumer and the
  documentation of that constant, not every file in this list.
  The `__tests__/terminal-states*.test.ts` suites check the terminal states
  against their exit codes mechanically.
- **New subprocess calls register for group cancellation.** A new `run()`
  call under `scripts/**` (`scripts/lib/proc.ts`) either passes `timeoutSec`
  for a bounded deadline, or `detached` + `onSpawn` for a process the caller
  intentionally runs long and cancels itself (for example the driver's pass
  command). A call using neither can outlive the driver. A raw
  `node:child_process` `spawn`/`spawnSync` has no `timeoutSec` option; route
  it through `run()` instead of hand-rolling a deadline.
- **The changed transition has test coverage.** The `__tests__/drive-pr-*.test.ts`
  suite (or the relevant sibling `__tests__/*.test.ts`) covers the state transition
  or script behavior the change touches. If the same file is being edited
  again in the same review cycle, consider whether the state machine should be
  consolidated rather than patched further.

All paths are relative to the skill directory.
