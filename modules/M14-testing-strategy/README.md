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
> a test or a registered exemption; tests never touch the developer's real
> state; and coverage is a scheduled trend, never a per-file gate.

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
   before its pass is trusted.
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

## Maturity levels

- **Lite** — the tiers are written down, each suite with its trigger and
  time budget, and the testing rules (doubles, clock, waiting, developer
  state) are written where agents and people will read them. Enforcement may
  be convention.
- **Standard** — every CI test job has an enforced time budget; the full
  end-to-end sweep runs only on a schedule or on demand (end-to-end tests of
  journeys nothing else checks stay in post-merge verification), and a lint fails a
  per-change trigger on it; test files are type-checked in CI; a gate fails a
  changed source file without a test or an exemption; and a gate rejects
  fixed sleeps without the registered token.
- **Strict** — a lint rule rejects direct wall-clock reads in runtime code;
  isolation predicates are tested in CI against the real engine; test runs
  are isolated from developer state mechanically; test doubles and builders
  are typed against the real contracts; and coverage is published as a
  scheduled trend that rejects incomplete data.

Some criteria are **expected-absent** by shape: a library with no running
system has no end-to-end sweep to place, and a repository with no database or
authorization layer has no isolation predicate to prove. The
[audit](../../plugin/skills/audit/README.md) calibrates by repository shape.

## Adoption steps

1. Copy [`templates/TESTING.md`](templates/TESTING.md) into your docs tree,
   fill in the tier table with your suites, triggers and budgets, and point
   your instruction file at it. This is **Lite**.
2. Enforce each CI test suite's tier budget on the command or step that runs
   it, inside a job timeout sized as M13's backstop; move the full
   end-to-end sweep to a nightly schedule and a manual trigger, and add a
   check over the CI configuration that fails if it gains a per-change trigger
   ([mappings.md](mappings.md#tiers-in-ci)).
3. Make sure your type check includes test files, and run it in CI.
4. Wire [`reference/tests-with-changes/`](reference/tests-with-changes/) into
   the pre-push hook and CI with your source globs and test layout; start an
   exemptions file with a reason on every line.
5. Add a grep gate or lint rule that rejects fixed sleeps without the
   `fixed-delay:` token, register the token in your suppression-token
   registry, and replace the sleeps it finds with a polling helper. This is
   **Standard**.
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
   test files; type doubles and builders against the real contracts; and
   schedule a coverage trend job. This is **Strict**.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/TESTING.md`](templates/TESTING.md) | A copyable testing strategy: the tier table, the rules, the exemption file and the fixed-delay token |
| [`reference/tests-with-changes/`](reference/tests-with-changes/) | The gate that fails a changed source file without a test or a registered exemption |
| [`reference/poll-until/`](reference/poll-until/) | A polling helper with a hard deadline, a named diagnostic and an injected clock |
| [`mappings.md`](mappings.md) | Per language and test runner: tier wiring, clock lint rules, polling helpers, builders, type-checked tests, coverage tools |
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

- **A skipped-suite check**: a job that provisions a real dependency fails
  when it ran zero tests, so a suite that silently skipped itself cannot
  report success.
- **[Flaky-test quarantine](../../GLOSSARY.md)**: no mechanism for setting a flaky test aside
  without hiding its failures has been validated yet.
- **Exceptions that prune themselves**: the tests-with-changes gate failing
  on an exemption that matches no file, and a gate for the `fixed-delay:`
  token that fails on a token with no delay beside it, as
  [M1](../M1-gates-enforcement-ladder/README.md) requires of every
  exception.
- **Stale-test triage**: when a test fails on a freshly fetched base, first
  telling a test the base change made stale apart from a real regression.
- **Tests that pin a dependency workaround**: a test asserting the dependency
  behaviour a workaround exists for, so it fails, and the workaround can go,
  once the dependency is fixed.
- **Running the suite on the next runtime release** (the language runtime's
  next version) on a schedule, so an incompatibility shows up before the
  upgrade rather than during it.
