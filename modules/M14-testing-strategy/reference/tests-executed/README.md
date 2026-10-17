# Skip tripwire

Part of [M14 Testing strategy](../../README.md).

A suite that needs a real dependency (a database, a queue, a browser, a
credential) usually skips itself when the dependency is missing, so the rest
of the tests still run on a machine without it. In the
[CI](../../../../GLOSSARY.md) job that provisions the dependency, that
courtesy turns into a [false green](../../../../GLOSSARY.md): the job passes
whether the suite ran or not. A misspelt connection variable, a test file
outside the runner's discovery root (the directories it looks in for tests),
a shard or path filter that matches nothing: each passes with zero tests
executed, and the runner's "0 pass" looks like every other green line. Most
runners report success for a selection that matched nothing, so the same
holds for any job that exists for one suite.

`check-tests-executed.ts` is the [skip tripwire](../../../../GLOSSARY.md):
it reads the JUnit report the runner wrote (the XML test report every
mainstream runner can write), counts the test cases that were not skipped,
and fails when the count is zero. It only detects; it changes nothing.

## Usage

```bash
bun check-tests-executed.ts [--each-suite] [--suite <name>]... <report.xml>...
```

- Every report named must exist, and every one must show at least one
  executed test case. A path the runner did not write (it found no test
  file, or the path is wrong) is an error, never a pass.
- `--each-suite` — every suite directly under the root element must have
  executed at least one case. A job that runs several suites which could
  each skip needs this: an aggregate count proves only that one of them
  ran. A suite nested inside a suite (a `describe` block in Bun's report)
  is not checked on its own, so a deliberately skipped block inside a file
  that ran does not fail.
- `--suite <name>` — a suite of that name must be in one of the reports,
  and every suite bearing it, at any depth, must have executed a case. Use
  it for the file a job exists for: a file the runner never discovered is
  otherwise invisible. The name is matched exactly against the report's
  `testsuite` name (a file path for Bun, Vitest, Jest and Playwright; a
  package for Go; a class for the JVM; `pytest` for a whole pytest run).

The script imports `lib/cli.ts`, `lib/findings.ts` and
`plugin/shared/junit-report.ts` from the Jig repository's root, so run it
from a pinned Jig checkout. To vendor it instead, copy those three files
with it and change its three imports to where the copies live; the two
`lib/` files import nothing beyond Node's `path` module and the JUnit
reader imports nothing at all, so no other import needs changing.

## What it reads

A JUnit report: a root `<testsuites>` holding `<testsuite>` elements, or a
single root `<testsuite>` (what Surefire, Failsafe and Gradle write, one
file per class). A `<testcase>` was executed unless it holds a `<skipped>`
child; a case that failed or errored was executed. The count comes from
the test cases, never from a suite's `tests` and `skipped` attributes,
because some runners write no `skipped` attribute and others count it
differently; and never from the runner's human summary line, whose wording
changes between versions. The report is read by the plugin's shared JUnit
reader (`plugin/shared/junit-report.ts`), a strict XML parser that reads
the document in order against the XML grammar; the text of comments,
`CDATA` sections and captured output is never read as markup, so output
that quotes a tag does not count.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every report, and every suite asked for, executed at least one test | one `OK` line per report with its counts, then what the check does not judge |
| 1 | A report, a top-level suite (`--each-suite`) or a named suite (`--suite`) executed none, or a named suite is in no report | one finding per case: the report, the counts, the fix; under GitHub Actions also an `::error` annotation |
| 2 | Usage error, or a report that could not be read | `could not check` with the reason, on standard error |

It [fails closed](../../../../GLOSSARY.md): a report that is missing, empty,
not well-formed XML (any construct the XML grammar does not allow where it
stands: a truncated file, text outside the root element, a repeated
attribute, an attribute on a closing tag, a `<` in an attribute value,
`]]>` in text, an entity other than the five predefined ones, a character
XML does not allow, a malformed or misplaced XML declaration, a `CDATA`
section or `DOCTYPE` out of place, or a `DOCTYPE` with an internal subset,
whose entities the reader does not expand), whose root is
another element, that puts a `<testsuites>` anywhere but at the root, a
`<testsuite>` anywhere but under the root or another suite, or a
`<testcase>` anywhere but directly under a suite, or that declares tests in its attributes but lists no test case
exits 2. Input the check could not read never passes, and output that
puts a case where JUnit has none cannot pass as execution.

## Wiring it into a job

Write the report with the runner's own flag, then run the check on that
path, in the same job and after the suite. The module's
[mappings](../../mappings.md#skipped-is-not-passed) give the flag per runner
and the workflow shape.

```sh
bun test src/db --reporter=junit --reporter-outfile=reports/db.xml
bun <jig>/modules/M14-testing-strategy/reference/tests-executed/check-tests-executed.ts \
  --each-suite reports/db.xml
```

Run it after a failed suite too (`if: always()` on GitHub Actions, or the
host's equivalent): a red that executed nothing is a different finding from
a red that failed, and the check's exit code says which.

## What it does not judge

It proves that test cases ran, not that they asserted anything. Pair it
with the module's other rules: a new test is seen to fail before its pass
is trusted, and test doubles reject what the real dependency rejects. It
does not check which cases were skipped, only that some were not; a job
that must run one specific file names it with `--suite`.

## Files

| File | Role |
|------|------|
| `check-tests-executed.ts` | the gate |
| `check-tests-executed.test.ts` | self-test: every fixture's exit code, the counts and remedy in the output, `--each-suite` and `--suite`, several reports, the annotation under GitHub Actions, usage errors, and the reader (character references, nesting, comments and `CDATA`, malformed input) |
| `fixtures/bun-healthy.xml` | a Bun report: one file whose cases ran, with skipped and todo cases and a skipped nested block; passes, also with `--each-suite` |
| `fixtures/bun-all-skipped.xml` | a Bun report whose only file skipped itself; fails |
| `fixtures/bun-two-files-one-skipped.xml` | two Bun files, one skipped: passes on the total, fails with `--each-suite` |
| `fixtures/pytest-all-skipped.xml` | a pytest report where every case skipped for a missing variable; fails |
| `fixtures/gotestsum-one-package-skipped.xml` | two Go packages, one skipped, with no `skipped` attribute on its suite; passes on the total, fails with `--each-suite` |
| `fixtures/vitest-one-file-skipped.xml` | two Vitest files, one skipped; passes on the total, fails with `--each-suite` |
| `fixtures/surefire-single-suite.xml` | a root `<testsuite>` with a comment and captured output that quote tags; passes with the right counts |
| `fixtures/no-tests.xml` | a report with no case at all; fails |
| `fixtures/declares-but-lists-none.xml` | attributes promise tests the report never lists; could not check |
| `fixtures/not-a-report.xml`, `fixtures/not-xml.txt`, `fixtures/empty.xml`, `fixtures/truncated.xml` | another XML document, a runner's summary text, an empty file, a report cut off mid-write; could not check |

Run the self-test with `bun test ./check-tests-executed.test.ts`.
