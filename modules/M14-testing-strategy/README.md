# M14 — Testing strategy

**What problem this solves.** Tests are the main evidence that a change
works, and that evidence wears away in two quiet ways. Slow suites creep into
the per-change gate: someone adds the full end-to-end sweep to every pull
request "to be safe", every change now waits half an hour, and people and
agents learn to batch changes, retry until green, or skip the gate. And
**false greens** hide failures: a stand-in for a real service that accepts any
input, a suite that skips itself when a secret is missing and reports success,
a test that sleeps five seconds and hopes the work is done, a test that was
never seen to fail. Each one passes while the thing it claims to check is
broken. Without a strategy, a green run means less every month and costs more.
This module says where each suite runs and how long it may take, and gives the
rules that make a passing test mean something.

## Invariant

> Every test suite has a declared **tier** with a trigger and a time budget;
> the full end-to-end sweep, whose journeys other checks already cover, never
> runs per change, and a check enforces that.
> A passing test means the behaviour works: **test doubles** reject what the
> real dependency rejects, runtime code reads time only from an **injected
> clock**, waits **poll** against a deadline instead of sleeping, isolation
> predicates are proven against the engine that evaluates them, test data
> comes from **typed builders**, test files are type-checked, and a new test
> is seen to fail before its pass is trusted. A changed source file comes with
> a test or a registered exemption; a job that exists for a suite fails
> unless the suite executed at least one test; a failure is attributed to a
> change only after it is reproduced on a freshly fetched base; every
> workaround for a dependency's defect has a test that pins the defect and
> names the workaround; the suites run against the next release of the
> runtime on a schedule that blocks nothing; tests never touch the
> developer's real state; and coverage is a scheduled trend, never a
> per-file gate.

Each piece below is a tool-independent rule; the tools that implement it in
each ecosystem are in [mappings.md](mappings.md). Terms in bold are defined in
the [glossary](../../GLOSSARY.md).

## Core pieces

1. **Tiers, with a trigger and a time budget.** Every suite belongs to a
   declared [test tier](../../GLOSSARY.md) that says what starts it and how
   long it may take, and the budget is enforced on the suite itself (a
   timeout on the command that runs it, or a step that fails when it runs
   over). The job's own timeout stays the generous backstop
   [M13](../M13-pipeline-economy/README.md#4-bound) sizes at about two to
   three times the slowest healthy run, so it enforces a budget alone only
   when the budget is that loose.

   | Tier | What it tests | Trigger | Example budget |
   |------|---------------|---------|----------------|
   | Unit | one piece of code, no network, no real services | every push | seconds; a minute at most |
   | Integration | code against real services (a database, a queue) | every pull request that changes their paths, and every push to the default branch | a few minutes |
   | End-to-end (critical journeys) | a journey nothing else checks, through the system's real interfaces | every push to the default branch, before the `verified` pointer moves | a few minutes |
   | End-to-end (full sweep) | the whole running system, journeys other checks already cover | nightly and on demand, never per change | as long as it needs, bounded by a timeout |

   A suite that outgrows its budget is split or moved to a less frequent
   trigger without changing what it tests; it does not quietly stretch the
   budget. The full end-to-end sweep is the suite
   most tempting to put back on every pull request, so its placement is
   checked, not just written down: a lint over the CI configuration fails if
   the workflow that runs it gains a per-change trigger. A cheap stand-in
   runs per change instead, such as "the end-to-end images still build".
   End-to-end tests that are the only check of a critical journey are not
   the sweep: [M10](../M10-environments-deploy/README.md)'s post-merge
   verification runs them, because the `verified` pointer needs their answer.
   Where a tier is selected by changed paths and its check is required,
   select it inside the pipeline rather than with a trigger-level path
   filter. A workflow that a path filter never starts leaves its required
   check pending, so the pull request cannot merge until someone runs it by
   hand; a job the pipeline itself skips reports a result
   ([M1's pull-request template](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
   shows the shape; [M3](../M3-change-area-catalog/README.md)'s catalog can
   supply the paths). Placement in general, what runs per change, after
   merge, on a schedule or on demand, belongs to
   [M13 (Pipeline economy)](../M13-pipeline-economy/README.md#6-place);
   [M10](../M10-environments-deploy/README.md)'s CI architecture says which
   suites the `verified` pointer waits for.
2. **Honest doubles.** A [test double](../../GLOSSARY.md) (a fake, stub or
   mock standing in for a real dependency) is part of what decides whether a
   test passes, so it must fail where the real dependency would. A fake
   command-line tool rejects a flag the real one does not accept; a fake API
   client rejects a request the real API would refuse. The double's accepted
   inputs are written independently of the code under test (never read from
   the same constant, or both repeat the same typo) and typed against the
   real contract. A new boundary is proven with a
   [mutation check](../../GLOSSARY.md): misspell the flag at the real call
   site, see the test fail, then restore it.
3. **Injected clock.** Runtime code gets the current time only from an
   [injected clock](../../GLOSSARY.md) passed in as a dependency, so a test
   can fix or advance time. A lint rule rejects direct reads of the wall
   clock outside the one adapter that implements the system clock.
   Arithmetic on a time obtained from the clock ("thirty days after
   `clock.now()`") is allowed; only reading "now" directly is not.
4. **Poll, don't sleep.** Waiting for external state (a job to finish, a row
   to appear) checks the state repeatedly against a hard deadline, and the
   failure message names what it waited for, how long and how many times it
   checked. A fixed delay is allowed only for local timing (a retry back-off,
   an abort deadline, the pause between two polls), and only with an inline
   [suppression token](../../GLOSSARY.md) such as `fixed-delay: <reason>`,
   registered in
   [M1's suppression-token registry](../M1-gates-enforcement-ladder/README.md).
   [`reference/poll-until/`](reference/poll-until/) is a small helper that
   does both.
5. **Predicates where they execute.** An
   [isolation predicate](../../GLOSSARY.md), the condition that keeps one
   tenant's rows from another, hides soft-deleted records, or checks an
   authorization, is tested against the engine that evaluates it (the real
   database, the real policy engine), with data that would leak if the
   predicate were missing: a second tenant's rows, a deleted record. A mock
   that returns only the rows the test expects proves nothing about the
   filter.
6. **Typed builders.** A [test-data builder](../../GLOSSARY.md) returns one
   declared contract type (the route's response type, the table's row type)
   with deterministic defaults (fixed identifiers and timestamps), and a test
   overrides only the fields it cares about. When the contract gains a
   required field, the builder fails the type check, or the completeness
   lint an ecosystem needs for that ([mappings](mappings.md#typed-builders)),
   instead of every test that uses it failing in a confusing way. This is
   distinct from
   [M10](../M10-environments-deploy/README.md)'s test-data factory, which
   seeds a running environment with realistic, tenant-isolated data:
   builders make values inside one test process, a factory fills a database
   that many runs share.
7. **Tests are code.** Test files are type-checked by the same check as
   runtime code, in CI; a test configuration that leaves them out makes a
   clean type check meaningless for them. A new test, probe or gate is seen
   to fail once (against a deliberately broken input or a mutated call site)
   before its pass is trusted. A test that asserts a spawned process's exit
   status asserts it through a helper that prints the child's captured
   output when the assertion fails
   ([`lib/test-helpers/expect-spawn-exit.ts`](../../lib/test-helpers/expect-spawn-exit.ts)
   is Jig's): a bare assertion reports two numbers and discards what the
   child printed, so a genuine regression and a process killed under load
   read alike, and the failure is dismissed as flaky. A lint rule flags the
   bare shape, under [M1's ratchet](../M1-gates-enforcement-ladder/reference/ratchet/README.md)
   where many exist ([mappings](mappings.md#spawned-exit-codes)).
8. **Tests come with changes.** A changed source file comes with a test, or
   its path is listed in a registered exemption with a reason. A gate checks
   it in a hook and in CI: [`reference/tests-with-changes/`](reference/tests-with-changes/)
   takes the base ref, the source globs, the test-path templates and the
   exemptions file as arguments.
9. **No real developer state.** A test that redirects process-global state
   (the home directory, the working directory, environment variables) does it
   in a subprocess it spawns, with the redirected values in that child's
   environment. Changing them inside the test process can leak into other
   tests running in the same process, and some runtimes read the home
   directory once at start-up, so the code under test would read and write
   the developer's real files.
10. **Coverage is a scheduled trend.** Coverage is measured on a schedule
    and published as a trend, including when it is below target, because the
    drop is when the chart matters. The publisher refuses incomplete data
    (a package whose report is missing or unreadable) rather than charting a
    partial number as if it were whole. Per-file blocking thresholds are not
    recommended: they punish whoever touches a legacy file, they invite tests
    written to raise the number rather than to check behaviour, and they
    block a merge on a percentage rather than on a behaviour that broke.
11. **Skipped is not passed.** A suite that needs a real dependency (a
    database, a queue, a browser, a credential) usually skips itself when
    the dependency is missing, so the rest of the tests still run on a
    machine without it. In the CI job that provisions the dependency, that
    courtesy becomes a false green: the job passes whether the suite ran or
    not, and a misspelt connection variable or a test file outside the
    runner's discovery root (the directories it looks in for tests) passes
    with nothing executed. Most runners also report success for a path or
    shard that matched nothing. So every job that exists for a suite ends
    with a [skip tripwire](../../GLOSSARY.md): it reads the runner's
    machine-readable report (the JUnit report every mainstream runner can
    write), counts the test cases that were not skipped, and fails when the
    count is zero or the report is missing. The count comes from the report,
    never from the runner's human summary line, whose wording changes
    between versions; and where a job runs several suites that could each
    skip, it is taken per suite, because an aggregate proves only that one
    of them ran. [`reference/tests-executed/`](reference/tests-executed/) is
    the check; the report flag per runner is in
    [mappings](mappings.md#skipped-is-not-passed).
12. **Triage before attribution.** A failing test is attributed before it is
    fixed. Where the test, the file it tests or their directory is not in
    the change, the failure is reproduced on a freshly fetched base, in a
    throwaway [worktree](../../GLOSSARY.md): never with a stash, because
    worktrees share one stash stack and a stash and pop can revert another
    session's files, and never by checking the base out in the working
    tree. The [fresh-base probe](../../GLOSSARY.md) checks out the commit
    the fetch returned, not the remote-tracking ref already present, which
    is only as fresh as the last fetch, and installs the dependencies into
    the worktree itself, because an install linked to the working checkout
    would run the change's code against the base's test; a fetch that
    fails is no answer. A command that fails on the base proves only that
    something failed there (a missing install, an import error, another
    test), and a test's name in the output proves nothing either, since a
    passing test prints its name too. So the failure counts as reproduced
    only when the failing test case's own result, in the report the runner
    writes on the base, is a failure (for a check with no per-case report, a
    type check or a lint, when the base's output shows the error message the
    change's failure showed). A failure that reproduces on the base is a
    [stale test](../../GLOSSARY.md), and the base's problem: it is fixed
    inline when the fix is cheap (an assertion value, a mock's return value,
    an import path), and otherwise deleted with a tracker item that records
    what it covered (the file, its cases, the behaviours they asserted, the
    failing output), so the coverage is owed rather than lost. A test is
    regenerated only when its premise is obsolete (its setup models a
    dependency shape or an architecture that no longer exists), and the new
    test asserts every behaviour the old one protected before the old one
    goes; a test is never regenerated to silence a failure. A stale test can
    exist at all because a per-change check scoped to the diff never runs
    for a change elsewhere, so the integration branch goes red without any
    pull request going red:
    [M13](../M13-pipeline-economy/README.md#2-select) asks for an unscoped
    run of those checks on the integration branch, where a red surfaces on
    its own. [`fix-ci`](../../plugin/skills/fix-ci/SKILL.md) runs this
    triage with its probe; the command per runner is in
    [mappings](mappings.md#triage-before-attribution).
13. **Behaviour pins for dependency workarounds.** A workaround for a defect
    in a dependency (a driver that double-encodes a value, a client that
    mis-parses a type) compensates for behaviour the dependency has today.
    When the dependency fixes the defect, the workaround keeps
    compensating for a problem that is no longer there, and a correct value
    now goes through a correction meant for a defective one. So every
    workaround has a [behaviour pin](../../GLOSSARY.md): a
    test that asserts the defective behaviour against the real dependency
    (not against the workaround, and not against a double of the
    dependency) and names in its title the workaround whose premise it
    pins. The pin fails on the release that fixes the defect, and that
    failure is the signal to retire or adapt the workaround in the same
    change that upgrades the dependency; the assertion is never updated on
    its own to make the pin pass again. The pin lives beside the
    workaround's code, so the two are found together, and because it needs
    the real dependency it is an integration-tier test whose job ends with
    the skip tripwire (piece 11), so it cannot green-skip. The shape per
    runner is in [mappings](mappings.md#behaviour-pins).
14. **Canary on the next release.** An upgrade of the runtime, a driver or
    a compiler is where behaviour pins and everything else break at once,
    and the day of the upgrade is the worst day to learn it. So a
    [runtime canary](../../GLOSSARY.md), a scheduled job, runs the most
    informative suites (the ones with behaviour pins, and the integration
    tier with its dependencies provisioned so the suites run rather than
    skip) against the dependency's next release (its canary, nightly, beta
    or release-candidate channel) and, where the product ships as a
    compiled binary, builds the binary with the next release and executes
    it against its exit-code contract. The canary never blocks: it has no
    per-change trigger and is no required check, because a red run is a
    finding to triage before the upgrade, not a reason to stop a merge. It
    records the exact build it ran (version and revision) in its summary,
    because next-release builds change daily and a red run must be
    attributable to one of them. Its pin on the next release is a deliberate
    exception to
    [M2's one version source](../M2-generated-artifact-freshness/README.md#one-version-source),
    registered there with its reason. A pin that fails in the canary is
    triaged as piece 13 says, and the upgrade that retires the workaround
    is the kind the planned `upgrade-deps`
    ([ROADMAP item 3](../../ROADMAP.md#3-the-kickoff-family)) is to drive.
    [`templates/runtime-canary.yml`](templates/runtime-canary.yml) is the
    workflow; the next-release channel per runtime is in
    [mappings](mappings.md#canary-on-the-next-release).

## Maturity levels

- **Lite** — the tiers are written down, each suite with its trigger and
  time budget, and the testing rules (doubles, clock, waiting, developer
  state) and the triage of a failure the change did not cause are written
  where agents and people will read them. Enforcement may be convention.
- **Standard** — every CI test job has an enforced time budget; the full
  end-to-end sweep runs only on a schedule or on demand (end-to-end tests of
  journeys nothing else checks stay in post-merge verification), and a lint fails a
  per-change trigger on it; test files are type-checked in CI, and an
  assertion on a spawned process's exit status goes through a helper that
  prints the child's output; a gate fails a
  changed source file without a test or an exemption; a gate rejects fixed
  sleeps without the registered token; every job that exists for a suite
  fails when the suite executed zero tests, counted from the runner's report;
  and every workaround for a dependency's defect has a behaviour pin that
  names it.
- **Strict** — a lint rule rejects direct wall-clock reads in runtime code;
  isolation predicates are tested in CI against the real engine; test runs
  are isolated from developer state mechanically; test doubles and builders
  are typed against the real contracts; coverage is published as a
  scheduled trend that rejects incomplete data; and a scheduled canary that
  blocks nothing runs the most informative suites, and a compiled-binary
  smoke test where there is a binary, against the next release of the
  runtime, recording the build it used.

Some criteria are **expected-absent** by shape: a library with no running
system has no end-to-end sweep to place, and a repository with no database or
authorization layer has no isolation predicate to prove. The
[audit](../../plugin/skills/audit/README.md) calibrates by repository shape.

## Adoption steps

1. Copy [`templates/TESTING.md`](templates/TESTING.md) into your docs tree,
   fill in the tier table with your suites, triggers and budgets, name your
   base branch and tracker in its triage rule, and point your instruction
   file at it. This is **Lite**.
2. Enforce each CI test suite's tier budget on the command or step that runs
   it, inside a job timeout sized as M13's backstop; move the full
   end-to-end sweep to a nightly schedule and a manual trigger, and add a
   check over the CI configuration that fails if it gains a per-change trigger
   ([mappings.md](mappings.md#tiers-in-ci)). In each job that exists for
   one suite (the integration job that provisions its database, a shard),
   write the runner's report and end the job with
   [`reference/tests-executed/`](reference/tests-executed/) on it
   ([mappings.md](mappings.md#skipped-is-not-passed)).
3. Make sure your type check includes test files, and run it in CI. Route
   every assertion on a spawned process's exit status through a helper that
   prints the child's output on a mismatch, and add a lint rule for the bare
   shape, under the ratchet where many exist
   ([mappings.md](mappings.md#spawned-exit-codes)).
4. Wire [`reference/tests-with-changes/`](reference/tests-with-changes/) into
   the pre-push hook and CI with your source globs and test layout; start an
   exemptions file with a reason on every line.
5. Add a grep gate or lint rule that rejects fixed sleeps without the
   `fixed-delay:` token, register the token in your suppression-token
   registry, and replace the sleeps it finds with a polling helper. Give
   every workaround for a dependency's defect a behaviour pin beside it,
   named for the workaround. This is **Standard**.
6. Introduce a clock interface, pass it into runtime code, and add the lint
   rule that bans direct wall-clock reads; start it under
   [M1's ratchet](../M1-gates-enforcement-ladder/reference/ratchet/README.md)
   if there are many existing reads.
7. Test isolation predicates against the real engine in a CI job that
   provisions it; isolate test runs from developer state by pointing the
   home directory, temp directory and the tool's own configuration at
   per-run locations before any code under test starts (the test command
   launches the runner with them set, or tests spawn the code under test
   with them set), and add a lint that rejects in-process changes to them in
   test files; type doubles and builders against the real contracts;
   schedule a coverage trend job; and copy
   [`templates/runtime-canary.yml`](templates/runtime-canary.yml), point it
   at the suites with behaviour pins and the integration tier, and register
   its next-release pin as an exception in your toolchain-pins declaration
   ([M2](../M2-generated-artifact-freshness/README.md#one-version-source)).
   This is **Strict**.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/TESTING.md`](templates/TESTING.md) | A copyable testing strategy: the tier table, the rules, the exemption file and the fixed-delay token |
| [`templates/runtime-canary.yml`](templates/runtime-canary.yml) | A scheduled, non-blocking workflow that runs the suites with behaviour pins and the integration tier, then a compiled-binary smoke test, on the runtime's next release, recording the build it used |
| [`reference/tests-with-changes/`](reference/tests-with-changes/) | The gate that fails a changed source file without a test or a registered exemption |
| [`reference/poll-until/`](reference/poll-until/) | A polling helper with a hard deadline, a named diagnostic and an injected clock |
| [`reference/tests-executed/`](reference/tests-executed/) | The skip tripwire: fails a job whose suites executed zero tests, counted from the runner's report |
| [`lib/test-helpers/expect-spawn-exit.ts`](../../lib/test-helpers/expect-spawn-exit.ts) | The exit-status assertions for a spawned process, which print the child's output on a mismatch; Jig's lint rule for the bare shape is [`tools/quality/grit/no-bare-exit-code-assertion.grit`](../../tools/quality/grit/no-bare-exit-code-assertion.grit) |
| [`lib/test-helpers/fake-program.ts`](../../lib/test-helpers/fake-program.ts) | A fake `gh`, `git` or `claude` on `PATH` that works the same way on every platform: the script itself on POSIX, a small executable that runs it under Git Bash on Windows (where a shebang means nothing and a `.cmd` wrapper is not found by a spawn); with `script-argv.ts` for running a script, and `windows-skip.ts` for a skip that names the piece of work lifting it, and a branch inside a test that says why |
| [`fix-ci`'s fresh-base probe](../../plugin/skills/fix-ci/scripts/probe-base.ts) | The runnable form of the triage: reproduces a failing check on a freshly fetched base in a throwaway worktree and says whether the failure is the change's, pre-existing, or undecidable |
| [`mappings.md`](mappings.md) | Per language and test runner: tier wiring, clock lint rules, polling helpers, builders, type-checked tests, coverage tools, report flags for the skip tripwire, the shape of a behaviour pin, the next-release channel per runtime |
| [maturity criteria](../../plugin/skills/audit/criteria/M14-testing-strategy.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference piece is a Bun/TypeScript script with a self-test.

### Left out by design

- **Live AI-evaluation gates that skip when their secrets are missing.** A
  gate that calls a live model, and exits successfully when the key is not
  available, reads as a pass on every fork and every misconfigured runner: a
  false green by construction. An evaluation suite belongs on a schedule with
  its credentials guaranteed, failing when they are not.
- **Per-file blocking coverage thresholds**, for the reasons in core piece
  10.
- **A clock lint rule as reference code.** The rule depends on the linter
  (a GritQL plugin, an ESLint selector, a Ruff setting), so
  [mappings.md](mappings.md#injected-clock) names the rule per ecosystem
  instead of shipping one.

### Future

- **[Flaky-test quarantine](../../GLOSSARY.md)**: no mechanism for setting a flaky test aside
  without hiding its failures has been validated yet.
- **Exceptions that prune themselves**: the tests-with-changes gate failing
  on an exemption that matches no file, and a gate for the `fixed-delay:`
  token that fails on a token with no delay beside it, as
  [M1](../M1-gates-enforcement-ladder/README.md) requires of every
  exception.
- **A new gate's first runs repeated before it blocks**: a test suite that
  becomes a gate starts failing changes the moment it runs on every pull
  request, and a flaky test that never failed in normal use (a race that
  loses one run in eight) fails someone else's change. Running the suite
  several times before the gate is made required would expose those tests
  while fixing them is still the gate author's work; no repeat count or
  procedure has been validated yet.
