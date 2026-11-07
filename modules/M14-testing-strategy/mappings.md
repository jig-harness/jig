# M14 mappings — per-ecosystem implementations

The module [invariant](README.md) is tool-independent: declared tiers with
budgets, honest doubles, an injected clock, polling instead of sleeping,
predicates proven where they execute, typed builders, type-checked tests,
tests with every change, no real developer state, coverage as a trend, and
a tripwire on suites that skipped themselves.
This file maps each piece onto concrete languages, test runners and
[CI](../../GLOSSARY.md) providers. Replace `<placeholders>` with your values.
The reference scripts need the pinned Bun runtime; everything else here
is a feature of the named tool.

## Tiers in CI

A tier is a trigger plus a time budget. The trigger is CI configuration. The
budget bounds the whole suite's elapsed time: a timeout on the command that
runs the suite, or a step that measures the run against the budget. The job
timeout bounds it too, but
[M13 sizes it](../M13-pipeline-economy/README.md#4-bound) as a generous
backstop, about two to three times the slowest healthy run and at most an
hour, so it enforces a budget alone only when the budget is that loose; a
tighter budget goes on the command or step. A per-test timeout in the runner
is useful too, but it bounds one test, not the suite: hundreds of tests each
under their limit can still run far past the tier's budget.

| CI provider | Every push / pull request | When paths change | Nightly and on demand | Job timeout (the backstop) |
|-------------|---------------------------|-------------------|-----------------------|-----------------|
| GitHub Actions | `on: push` / `on: pull_request` | a resolver job that lists changed files and sets outputs the tier's job reads in `if:` (a trigger-level `paths:` filter never starts the workflow, which leaves its required check pending and blocks the merge) | `on: schedule` (cron) and `on: workflow_dispatch` | `timeout-minutes` on the job |
| GitLab CI | default pipeline on push and merge request | `rules: - changes: [<paths>]` | `rules: - if: $CI_PIPELINE_SOURCE == "schedule"` plus a pipeline schedule; `when: manual` for on demand | `timeout:` on the job |
| CircleCI | default workflow | the `path-filtering` orb | scheduled pipelines; an API-triggered pipeline with a parameter | the suite's command wrapped in `timeout <duration>` (from coreutils); `no_output_timeout` on a step bounds only silence, not total time |
| Jenkins | the multibranch job | `when { changeset "<glob>" }` | `triggers { cron('H 2 * * *') }`; "Build with parameters" | `options { timeout(time: 10, unit: 'MINUTES') }` |

Within a suite, the test runner selects the tier and bounds each test:

| Runner | Select a tier | Per-test time limit |
|--------|---------------|---------------------|
| Bun | separate directories or file name patterns passed to `bun test` | `bun test --timeout <ms>` |
| Vitest | `projects` (one per tier) or `--project` | `testTimeout` |
| Jest | `projects`, or `--selectProjects` | `testTimeout` |
| pytest | markers (`@pytest.mark.integration`) selected with `-m` | the `pytest-timeout` plugin (`--timeout`) |
| Go | `//go:build integration` build tags, or `testing.Short()` with `go test -short` | `go test -timeout <duration>` (whole binary) |
| JUnit 5 | `@Tag("integration")` with Gradle's `useJUnitPlatform { includeTags(...) }` or Maven Surefire `groups`; Maven Failsafe for `*IT` classes | `@Timeout`, or `junit.jupiter.execution.timeout.default` |
| xUnit / NUnit (.NET) | `[Trait("Category", "Integration")]` / `[Category]` with `dotnet test --filter` | xUnit `[Fact(Timeout = <ms>)]` on async tests; NUnit `[Timeout]` / `[CancelAfter]` |

A budget can also be measured: record the start time, run the suite, and
fail the step when it took longer than the tier allows, naming the budget in
the error. That catches a suite slowly growing towards the job timeout.

**Keeping the full end-to-end sweep off the per-change path.** Put a marker
comment in each workflow that runs the full sweep (for example
`# test-tier: end-to-end`), and add a [grep gate](../../GLOSSARY.md) over the
CI configuration that fails when a marked file declares a per-change trigger
(`pull_request`, `pull_request_target` or `push` in GitHub Actions; a rule
without the schedule condition in GitLab CI). Make the gate also fail when a
workflow runs the end-to-end command without the marker, so the ban cannot be
dodged by leaving it off. [M1](../M1-gates-enforcement-ladder/README.md)'s
grep-gate convention applies: a self-test with fixtures, run in CI.

## Honest doubles

| Ecosystem | Typed against the real contract | Rejects what the real dependency rejects |
|-----------|---------------------------------|------------------------------------------|
| TypeScript | type the double as the real interface (`const repo: Pick<OrderRepository, "find"> = …`, or `satisfies OrderRepository`); never `any` | Mock Service Worker with `onUnhandledRequest: "error"` fails a request no handler expects; a fake command checks its arguments (below) |
| Python | `unittest.mock.create_autospec(Real)` or `patch(..., autospec=True)`: a call with the wrong signature raises | `responses` raises on a request it was not told about; `respx` can assert that every request was mocked |
| Go | the double implements the consumer's interface, so the compiler checks it | `go.uber.org/mock` (gomock) fails the test on an unexpected call; `httptest.NewServer` with a handler that returns an error for unknown paths |
| JVM | Mockito mocks of the real type; WireMock stubs from the provider's contract | Mockito's strict stubs (the default with `MockitoExtension`) report an argument mismatch; WireMock answers an unmatched request with 404 |
| Any HTTP API | a consumer-driven contract (Pact) verified against the provider | the provider verification fails when the consumer expects something the provider does not do |

**A fake command-line tool** (a script put first on `PATH` to stand in for a
vendor CLI) holds, per subcommand, the flags and operands the installed
version accepts, written from that tool's own help or reference rather than
from the code under test. It exits non-zero with "unknown flag" for anything
else, before it picks a canned response. Prove each new boundary with a
[mutation check](../../GLOSSARY.md): change a flag at the real call site to a
misspelling, run the test, see it fail on the fake's error, and restore the
call site (or run the mutation on a temporary copy).

## Injected clock

| Ecosystem | The clock | Lint rule that bans reading the wall clock | Test side |
|-----------|-----------|--------------------------------------------|-----------|
| TypeScript / JavaScript | an interface such as `{ now(): Date }` passed in as a dependency, with one system implementation | a Biome [GritQL](../../GLOSSARY.md) plugin matching `Date.now()` and a no-argument `new Date()`; or ESLint `no-restricted-syntax` with the selectors `CallExpression[callee.object.name='Date'][callee.property.name='now']` and `NewExpression[callee.name='Date'][arguments.length=0]` | a fixed or advancing fake; for code not yet migrated, `setSystemTime` (`bun:test`), `vi.setSystemTime` (Vitest), `jest.setSystemTime` (Jest) |
| Python | a callable (`now: Callable[[], datetime]`) or a small protocol | Ruff `flake8-tidy-imports` `banned-api` (rule `TID251`) on `datetime.datetime.now`, `datetime.datetime.utcnow` and `time.time`; Ruff's `flake8-datetimez` (`DTZ`) rules additionally require time-zone-aware values | a fake callable; `freezegun` or `time-machine` for code not yet migrated |
| Go | a `func() time.Time` field or a clock interface (`k8s.io/utils/clock`, `github.com/jonboulle/clockwork`) | golangci-lint `forbidigo` with the pattern `^time\.Now$` | the libraries' fake clocks; `testing/synctest` runs a test in a bubble with its own fake time |
| JVM | `java.time.Clock` injected; `Instant.now(clock)`, `LocalDate.now(clock)` | an ArchUnit rule that no class outside the clock adapter calls `Instant.now()`, `LocalDateTime.now()` or `System.currentTimeMillis()` | `Clock.fixed(...)`, `Clock.offset(...)` |
| .NET | `TimeProvider` (.NET 8 and later) injected | `Microsoft.CodeAnalysis.BannedApiAnalyzers` (rule `RS0030`) with `DateTime.Now`, `DateTime.UtcNow` and `DateTimeOffset.UtcNow` in `BannedSymbols.txt` | `FakeTimeProvider` (`Microsoft.Extensions.TimeProvider.Testing`) |

Scope the rule to runtime code and exclude the one system-clock adapter.
Arithmetic on a value the clock returned stays allowed: the rule matches the
read, not `new Date(<value>)` or date arithmetic. If the codebase has many
existing reads, put the rule at warning level under
[M1's ratchet](../M1-gates-enforcement-ladder/reference/ratchet/README.md) so
the count can only fall.

## Poll, don't sleep

| Ecosystem | Polling with a deadline | Rule against fixed sleeps |
|-----------|-------------------------|---------------------------|
| TypeScript (Bun, any runtime) | [`reference/poll-until/`](reference/poll-until/) | [`reference/fixed-delay/`](reference/fixed-delay/) over test and tooling code: its default texts are `Bun.sleep(`, `setTimeout(`, `sleep(` and `time.sleep(`, and it accepts a `fixed-delay: <reason>` comment on the same line or the line above |
| Vitest / Jest | `vi.waitFor(fn, { timeout, interval })`, `expect.poll` (Vitest); Testing Library's `waitFor` | the same gate |
| Playwright | `expect.poll(fn, { timeout })`, `expect(fn).toPass()`, and auto-waiting assertions such as `toBeVisible()` | `eslint-plugin-playwright`'s `no-wait-for-timeout` |
| Python | `tenacity` (`retry_if_result`, `stop_after_delay`, `wait_fixed`) | [`reference/fixed-delay/`](reference/fixed-delay/) on the test files with `--pattern 'time.sleep(' --pattern 'asyncio.sleep('`, which accepts the repository's own `# fixed-delay: <reason>` comment (Ruff `TID251` can ban it too, but its `# noqa` is a tool-native escape that M1's registry leaves out and that needs no reason) |
| Go | testify's `require.Eventually(t, cond, waitFor, tick)`; Gomega's `Eventually`; `wait.PollUntilContextTimeout` (`k8s.io/apimachinery`) | golangci-lint `forbidigo` on `^time\.Sleep$` in `_test.go` files |
| JVM | Awaitility: `await().atMost(Duration.ofSeconds(30)).until(...)` | ArchUnit rule against `Thread.sleep` in test classes |

Whatever the helper, the failure message names what was awaited, and the
fixed-delay token is registered in
[M1's suppression-token registry](../M1-gates-enforcement-ladder/templates/suppression-registry.md)
with its consuming gate, its placement and when it is stale (no delay on its
line or the line below). The fixed-delay gate has no imports beyond Bun's
and Node's built-ins, so a repository can copy `check-fixed-delay.ts` as it
is, or run it from a pinned Jig checkout as the
[tests-with-changes recipe](#tests-come-with-changes) does.

## Predicates where they execute

Run the real engine in the test job and seed data the predicate must hide.

| Need | Tools |
|------|-------|
| A real database per test run | Testcontainers (Java, Go, Node, Python, .NET); a database service container in the CI job (GitHub Actions `services:`, GitLab CI `services:`) |
| Tenant scope enforced by the database | PostgreSQL row-level security tested inside a transaction that sets the session's role and tenant settings (`SET LOCAL ROLE`, `set_config(..., true)`) and is rolled back at the end; pgTAP for tests written in SQL |
| Authorization policies | the policy engine's own test runner, such as `opa test` for Open Policy Agent |

Each test seeds at least two tenants (or a live and a soft-deleted record),
asserts what the predicate lets through, and asserts what it hides. A test
that seeds one tenant passes whether the predicate exists or not.

## Typed builders

| Ecosystem | Builders | Deterministic values |
|-----------|----------|----------------------|
| TypeScript | a plain function with an explicit return type and `Partial<T>` overrides; `fishery` (`Factory.define<Order>(...)`) | fixed timestamps and identifiers, or `faker.seed(<n>)` with `@faker-js/faker` |
| Python | a function that calls the constructor with every field by name, `def an_order(**overrides) -> Order: return dataclasses.replace(Order(id="order-1", status="open"), **overrides)`, checked by mypy or Pyright; `factory_boy` and `polyfactory` generate values at run time | fixed values in the builder; `factory.random.reseed_random(<seed>)` for a generator |
| Go | a function returning the struct, with functional options for overrides; `exhaustruct` (in golangci-lint) run over the builders, so a field left out of the literal fails the lint | fixed values; no `time.Now()` in defaults |
| JVM | the test-data builder pattern; Instancio; Kotlin functions with default arguments | `Instancio` with a fixed seed; fixed values |
| .NET | AutoFixture; Bogus (`new Faker<Order>()`) | `Randomizer.Seed` in Bogus; fixed values |

The builder returns the contract type the consumer reads (the response type,
the table's row type), so adding a required field to that type breaks the
builder at compile time. That holds only for a builder that builds the value
itself, with a typed constructor call or literal: a plain function, the
builder pattern, Kotlin default arguments, `fishery`'s typed `define`.
Go is the exception among those: a keyed struct literal compiles with fields
left out and gives them their zero value, so a Go builder gets the same
guarantee only from a linter that requires every field in the literal
(`exhaustruct`), run over the builders in the per-change gate.
Generators that fill fields by reflection at run time (`factory_boy`,
`polyfactory`, Instancio, AutoFixture, Bogus) still compile when the type
gains a field and fail, or silently fill it, only when they run. Use them for
values inside a typed builder, not as the builder.

## Tests are code

| Ecosystem | Test files type-checked by |
|-----------|----------------------------|
| TypeScript | the type check covering test files: test paths in the `tsconfig.json` `include`, or a `tsconfig.test.json` checked with `tsc --noEmit -p` (or `bun check -p`) in CI. A runner that strips types without checking them (Bun, Vitest, `babel-jest`) does not type-check |
| Python | mypy or Pyright with `tests/` in its configured paths |
| Go, JVM, .NET | the compiler: `go vet ./...` and `go test` compile test files; `mvn test-compile` / `gradle compileTestJava`; `dotnet build` |

To trust a new type check over tests, put a deliberate type error in one test
file and see the check report it before relying on a clean run.

### Spawned exit codes

An assertion on a spawned process's exit status prints the child's captured
output when it fails, so a regression is told apart from a process killed
under load. The spawn call pipes both streams; a result that captured
neither says so rather than leaving the fields out.

| Ecosystem | Helper | Lint for the bare shape |
|-----------|--------|-------------------------|
| TypeScript (Bun, Node) | [`lib/test-helpers/expect-spawn-exit.ts`](../../lib/test-helpers/expect-spawn-exit.ts): `expectSpawnExit(result, code)`, `expectSpawnExitNot(result, code)` and `expectSpawnKilled(result)` take the spawn result with its piped `stdout` and `stderr` (`null` where a run captured none) and throw with both on a mismatch; an in-process runner that returns `{ exitCode, stdout }` passes `stderr: null` | Biome: a GritQL plugin on `expect($result.exitCode).$matcher(...)` and its `.not` form in test files, [`tools/quality/grit/no-bare-exit-code-assertion.grit`](../../tools/quality/grit/no-bare-exit-code-assertion.grit), at `warn` under the ratchet; ESLint: `no-restricted-syntax` with a selector for a call to `expect` whose argument is a member named `exitCode`. Node's `status` field is not matched, since HTTP responses share the name: read a Node result into the helper's shape |
| Python | `subprocess.run(..., capture_output=True, text=True)` and `assert result.returncode == code, result.stdout + result.stderr`, or a fixture that wraps the run and the assertion | a grep gate over test files for `returncode ==` in an `assert` without a message |
| Go | `out, err := cmd.CombinedOutput()`, then `t.Fatalf("%v\n%s", err, out)` on failure; the code is on `exec.ExitError` | review: `go vet` has no such rule |
| JVM, .NET | the assertion's message argument carries the captured output (`assertEquals(0, code, output)`; a helper that throws with the output around `Assert.Equal`) | review |

## Tests come with changes

[`reference/tests-with-changes/`](reference/tests-with-changes/) takes the
layout as arguments. Typical templates:

| Layout | `--source` | `--test` |
|--------|------------|----------|
| TypeScript, tests beside the source | `src/**/*.ts` | `{dir}/{name}.test.{ext}`, `{dir}/__tests__/{name}.test.{ext}` |
| Python, mirrored `tests/` tree | `src/**/*.py` | `{dir:src=tests}/test_{name}.py` |
| Go | `**/*.go` | `{dir}/{name}_test.go` |
| Maven or Gradle (Java) | `src/main/java/**/*.java` | `{dir:src/main/java=src/test/java}/{name}Test.java` |

Run it from a pinned Jig checkout (it imports `lib/cli.ts` from Jig's root),
with `M14` set to the module's path inside that checkout. Pin Jig to a
release that contains M14 (0.27.0 or later) by its full commit hash; the
other two actions are pinned as Jig's own workflow pins them:

```yaml
# GitHub Actions
jobs:
  tests-with-changes:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      M14: .jig/modules/M14-testing-strategy
      BASE: ${{ github.event.pull_request.base.sha }}
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10   # v6
        with: { fetch-depth: 0 }                   # the gate needs the merge base
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10   # v6
        with:
          repository: <jig-repository>             # where you take Jig from
          ref: <full-commit-sha-of-a-jig-release>  # 0.27.0 or later
          path: .jig
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6   # v2.2.0
        with:
          bun-version-file: .jig/package.json      # Jig's pinned Bun, not the latest
      - run: bun test "$M14"/reference/tests-with-changes/check-tests-with-changes.test.ts
      - run: >-
          bun "$M14"/reference/tests-with-changes/check-tests-with-changes.ts
          --base "$BASE" --source 'src/**/*.ts'
          --test '{dir}/{name}.test.{ext}' --exemptions .config/test-exemptions.txt
```

In a pre-push hook (lefthook, husky or pre-commit), pass the branch the
change merges into as `--base`.

## No real developer state

Every row runs the code under test in a child process that gets the
redirected values, which is what the rule asks for. The in-process helpers
some runners offer are named where they exist; they restore the value after
the test but still change it for the whole process while it runs, so they do
not satisfy the rule.

| Ecosystem | Spawning the code under test with its own home, directory and environment |
|-----------|-----------------------------------------------------------------------------|
| Bun | spawn a child (`Bun.spawn([...], { env: { ...env, HOME: fakeHome }, cwd })`): Bun's `os.homedir()` does not re-read `HOME` after start-up, so an in-process assignment leaves the code under test on the real home directory. Set the temp directory and the tool's own configuration in the environment the test command launches `bun test` with (a wrapper script, or `env TMPDIR=… bun test`). Not the rule: a test preload (`[test] preload` in `bunfig.toml`), which changes them inside the test process |
| Node.js test runners | `child_process.spawn` / `execFile` with `env` and `cwd` options. Not the rule: `process.chdir`, which moves every test in the worker |
| pytest | `subprocess.run([...], env={**os.environ, "HOME": str(tmp_path)}, cwd=tmp_path)`, with `tmp_path` as the fake home. Not the rule: `monkeypatch.setenv` / `monkeypatch.chdir`, which are undone after the test but change the whole process meanwhile |
| Go | `exec.Command` with `cmd.Env` and `cmd.Dir`; or re-run the test binary as the child (`os.Args[0]` with `-test.run`), the standard library's own pattern. Not the rule: `t.Setenv` / `t.Chdir` (Go 1.24 and later), which are undone after the test but are process-wide while it runs, which is why they refuse parallel tests |
| JVM | `ProcessBuilder` with its `environment()` and `directory(...)`, or a forked test JVM. Not the rule: `System.setProperty`, which is global to the JVM |

Pair the isolation with a lint or grep gate that rejects the in-process
forms in test files (`process.env.HOME =`, `process.chdir(`), with the
subprocess as the alternative its message names. The audit asks for both:
the isolation set before code under test starts, and the lint.

## Coverage as a scheduled trend

| Ecosystem | Coverage report |
|-----------|-----------------|
| Bun | `bun test --coverage --coverage-reporter=lcov` |
| Vitest / Jest | `@vitest/coverage-v8` or `@vitest/coverage-istanbul`; Jest `--coverage` (both write `lcov` and `json-summary`) |
| Python | coverage.py, or `pytest-cov` (`--cov --cov-report=xml`) |
| Go | `go test -coverprofile=cover.out ./...`, `go tool cover` |
| JVM | JaCoCo (`jacoco:report`, Gradle `jacocoTestReport`) |
| .NET | coverlet (`dotnet test --collect:"XPlat Code Coverage"`) |

Run the coverage job on a schedule (weekly is usually enough) and on demand,
not per change. Publish the numbers even when the run fails a target: a
failing step must not skip the publish step. The publisher compares the
packages it found reports for with the list it expected and refuses to
publish when one is missing or unreadable. Where a package's report also
covers source from other packages, chart each package on its own: summing
them counts shared files twice. Hosted services that chart the trend
(Codecov, Coveralls) can report a status that never blocks (Codecov's
`informational: true`); runner settings that block per file (Jest
`coverageThreshold` with path keys, Vitest `coverage.thresholds.perFile`,
JaCoCo `check` rules per class) are what the module advises against.

## Skipped is not passed

[`reference/tests-executed/`](reference/tests-executed/) reads the JUnit
report (the XML test report every runner below can write) and fails when
the test cases that were not skipped number zero. Write the report with the
runner's own flag, then run the check on it in the same job, after the
suite. Each row names the flag and how a suite's self-skip shows in the
report, which is what the check counts.

| Runner | Write the report | How a self-skip appears in it |
|--------|------------------|-------------------------------|
| Bun | `bun test <paths> --reporter=junit --reporter-outfile=<file>` | `describe.skipIf(...)` and `test.skipIf(...)` cases carry `<skipped />`; one `<testsuite>` per file, with one nested per `describe` |
| Vitest | `vitest run --reporter=junit --outputFile=<file>` | `describe.skipIf` and `test.skip` cases carry `<skipped/>`; one `<testsuite>` per file |
| Jest | the `jest-junit` reporter (`--reporters=default --reporters=jest-junit`), with `JEST_JUNIT_OUTPUT_DIR` and `JEST_JUNIT_OUTPUT_NAME` naming the file | `describe.skip` and `test.skip` cases carry `<skipped/>`; one `<testsuite>` per file |
| Playwright | `playwright test --reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<file>` | `test.skip(condition)` cases carry `<skipped/>`; one `<testsuite>` per file |
| pytest | `pytest --junitxml=<file>` | `pytest.mark.skipif`, `pytest.skip(allow_module_level=True)` and `pytest.importorskip` cases carry `<skipped>`; one `<testsuite>` named `pytest` for the whole run, so a per-file count means one run per file |
| Go | `gotestsum --junitfile <file> ./...` (`go test` alone writes no report) | `t.Skip` and `testing.Short()` cases carry `<skipped>`; one `<testsuite>` per package, without a `skipped` attribute, which is why the check counts cases rather than attributes |
| JVM (JUnit 5) | Maven Surefire and Failsafe write `target/surefire-reports/TEST-*.xml` and `target/failsafe-reports/TEST-*.xml`; Gradle writes `build/test-results/test/TEST-*.xml`; pass every file | a failed assumption (`Assumptions.assumeTrue`), `@EnabledIfEnvironmentVariable` and Testcontainers' `disabledWithoutDocker` cases carry `<skipped>`; one file per class, each a root `<testsuite>` |
| .NET | `dotnet test --logger "junit;LogFilePath=<file>"` with the `JunitXml.TestLogger` package | xUnit `Skip =` and NUnit `Assume.That` cases carry `<skipped/>` |
| Ruby (RSpec) | `rspec --format RspecJunitFormatter --out <file>` (the `rspec_junit_formatter` gem) | `skip` and `pending` examples carry `<skipped/>` |
| PHPUnit | `phpunit --log-junit <file>` | `markTestSkipped` cases carry `<skipped/>` |

A job that runs several suites which could each skip passes `--each-suite`,
so one suite that ran does not vouch for the others. A job that exists for
one file names it with `--suite <name>`, as the report names it, so a file
the runner never discovered is a failure rather than a silence. A runner
given a path or shard that matches nothing usually exits 0 and writes no
report; the check then reports could not check (exit 2), and the job fails
either way.

Run it from a pinned Jig checkout, as the
[tests-with-changes recipe](#tests-come-with-changes) does, in the job that
provisions the dependency:

```yaml
# GitHub Actions: the job that provisions the database, after the pinned Jig
# checkout and setup-bun steps of the recipe above
      - name: Run the integration suite with a report
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/app
        run: bun test src/db --reporter=junit --reporter-outfile=reports/db.xml
      - name: Fail unless the suite executed a test
        if: always()
        run: >-
          bun "$M14"/reference/tests-executed/check-tests-executed.ts
          --each-suite reports/db.xml
```

The report path the second step names is the one the first wrote; a path
the runner did not write fails the step. The same two commands go into a
GitLab CI `script:` list, a Jenkins `sh` step or a CircleCI `run`.

## Triage before attribution

The [fresh-base probe](../../GLOSSARY.md) is runner-independent:
[`fix-ci`'s `probe-base.ts`](../../plugin/skills/fix-ci/scripts/probe-base.ts)
takes the base branch, the failing test's name (`--expect`), the JUnit
report the command writes (`--junit`, with the runner's flag from *Skipped
is not passed* above) and the command that runs the one failing file,
fetches the base, runs the command in a throwaway worktree at the commit the
fetch returned, removes the worktree, and exits 0 (that test case passed on
the base: the failure is the change's), 1 (it failed there: pre-existing)
or 2 (could not decide: the fetch failed, no worktree, the command did not
run, or the report has no case by that name, several with different
results, or only skipped ones). The verdict reads the case, not the output:
a passing test prints its name too, so a name in a failed run's output says
nothing about which test failed. A check with no per-case report (a type
check, a lint) is probed without `--junit`, with the error message as
`--expect`, and counts as pre-existing when it fails on the base showing
that message.
The worktree starts with nothing installed, so `--setup` names the
repository's install command, run there first: `bun install
--frozen-lockfile`, `npm ci`, `pnpm install --frozen-lockfile`, `yarn install
--immutable`, `bundle install`, `composer install`; for Python a fresh
virtual environment in the worktree (`uv sync`, or `python -m venv .venv &&
.venv/bin/pip install -e .`), because an editable install into the working
checkout's environment points at that checkout's sources and the probe
would run the change's code against the base's test; Go, the JVM and .NET
resolve through their build tool's shared cache and need no step. The setup
runs in a shell of its own, so the test command reaches the worktree's
environment directly (`uv run pytest`, `.venv/bin/python -m pytest`, `bundle
exec rspec`): a bare `pytest` resolves from the caller's `PATH`, which can be
the working checkout's environment. Without the plugin, five commands do the
same: `git fetch origin <base>`, stopping if it fails; `git worktree add
--detach <new path> FETCH_HEAD`; the install command, then the test command,
both run from that path, reading the report for the failing case's result;
`git worktree remove --force <path>`. The command per runner is the one
that runs a single file:

| Runner | Run one failing file on the base |
|--------|----------------------------------|
| Bun | `bun test <file>` |
| Vitest | `vitest run <file>` |
| Jest | `jest <path>` |
| Playwright | `playwright test <file>` |
| pytest | `uv run pytest <file>` or `.venv/bin/python -m pytest <file>` (`<file>::<test>` for one case) |
| Go | `go test ./<package> -run '^<TestName>$'` |
| JVM | `mvn -q test -Dtest=<Class>` (Gradle: `gradle test --tests <Class>`) |
| .NET | `dotnet test --filter "FullyQualifiedName~<Class>"` |
| Ruby (RSpec) | `rspec <file>` |
| PHPUnit | `phpunit <file>` |

```bash
# From the repository whose check failed, with the plugin's skill directory in SKILL
bun "$SKILL/scripts/probe-base.ts" --base main --setup "bun install --frozen-lockfile" --expect "total rounds to cents" --junit probe.xml -- bun test src/cart/total.test.ts --reporter=junit --reporter-outfile=probe.xml
bun "$SKILL/scripts/probe-base.ts" --base develop --remote upstream --setup "uv sync" --expect test_total_rounds --junit probe.xml -- uv run pytest tests/test_total.py --junitxml=probe.xml
```

The tracker item that records a deleted stale test is opened with the
tracker's own command-line tool (`gh issue create --body-file <notes>`,
`glab issue create`, the tracker's CLI); its body lists the file, the number
of cases, the behaviours they asserted, the failing output and why the fix
was not cheap, so the coverage is owed, not lost.

A per-change check scoped to the diff (Turborepo `--filter=...[<base>]`, Nx
`affected`, a job-level path condition, a change-area resolver) is what lets
a stale test exist; its unscoped run on the integration branch, per CI host,
is in [M13's mappings](../M13-pipeline-economy/mappings.md).

## Behaviour pins

A pin asserts the dependency's defective behaviour against the real
dependency, so it belongs to the integration tier, skips itself without the
dependency, and runs in the job that provisions it, which ends with the
[skip tripwire](#skipped-is-not-passed). Its title names the workaround, so
a failure reads as the signal to retire or adapt that workaround; its header
says
which release fixes the defect, when that is known, and that the assertion
is never updated on its own.

| Runner | The shape of a pin |
|--------|--------------------|
| Bun, Vitest, Jest | a `<workaround>.pins.integration.test.ts` beside the workaround's file, each `describe` named for the defect and the workaround file whose premise it pins |
| Playwright | the same file beside the client-side workaround, run against the real browser |
| pytest | a `test_<workaround>_premise.py` beside the workaround, each test's docstring naming the workaround and the defect |
| Go | `Test<Workaround>Premise` functions in the workaround's package, against the real driver |
| JVM, .NET | a test class named for the workaround's premise in the workaround's package or project |

## Canary on the next release

[`templates/runtime-canary.yml`](templates/runtime-canary.yml) is the
workflow. Each row says how the runtime's next release is installed in a
GitHub Actions step and which command prints the build it ran, which the
workflow writes to the run summary; the pin the canary holds (`canary`,
`nightly`, `head`, a release candidate) is registered as an exception in the
repository's toolchain-pins declaration
([M2](../M2-generated-artifact-freshness/mappings.md#toolchain-pin-sites)).

| Runtime | The next release, in a setup step | The build it ran |
|---------|-----------------------------------|------------------|
| Bun | `oven-sh/setup-bun` with `bun-version: canary` | `bun --version` and `bun --revision` |
| Node.js | `actions/setup-node` with a version-qualified nightly, `node-version: <next>-nightly` (a release candidate is named exactly, `node-version: <next>.0.0-rc.1`; there is no bare `rc` alias) | `node --version` |
| Deno | `denoland/setup-deno` with `deno-version: canary` | `deno --version` |
| Python | `actions/setup-python` with `python-version: <next>-dev` and `allow-prereleases: true` | `python --version` |
| Go | `go install golang.org/dl/gotip@latest && gotip download`, then `gotip` in place of `go` | `gotip version` |
| Rust | `dtolnay/rust-toolchain@beta` (or `@nightly`) | `rustc --version --verbose`, which includes the commit |
| Ruby | `ruby/setup-ruby` with `ruby-version: head` | `ruby --version`, which includes the revision |
| JVM | `actions/setup-java` with `java-version: <next>-ea` | `java -version` |
| .NET | `actions/setup-dotnet` with `dotnet-version: <next>.0.x` and `dotnet-quality: preview` | `dotnet --version` |
| A driver or library | install it at its pre-release tag in the canary job only (`npm install <package>@next`, `pip install --pre <package>`), leaving the lockfile as it is | the resolved version in the package manager's listing |

The compiled-binary job uses the same build command and target as the
release build (`bun build --compile --target=<target>`, `go build`,
`cargo build --release`, `dotnet publish`), so the canary compiles what
production runs, and executes the binary once in a way that must succeed
and once in a way that must fail, so the exit-code contract is checked
rather than only the start.
