# Native gate migration

The Bash gates and the Bun replacements were run against the same fixtures
before the operated shell implementations were removed. The baseline is the
parent revision, `79dc7d2`; fixture inputs retain their original bytes except
for the generated indexes' regeneration-command headers.

| Area | Comparison performed |
|------|----------------------|
| Repository checks | 14 link/table/glossary/tracker fixture cases and 6 saved branch-protection responses returned identical exit codes; ignored-workspace and permission regressions also passed |
| M0–M2 | Skill mirror sync/check, TODO fixtures, staged review markers, prose counts/paths and fresh/stale indexes compared against Bash; generator bodies matched after the intentional command-header change |
| M3–M5 | 125 existing fixture verdicts matched: 106 catalog-parser cases, 6 frontmatter, 5 scar, 3 numbering and 5 decision-rule cases; 52 reports matched byte for byte |
| M6–M9 | All 11 original self-test suites passed against both implementations; 120 fixture exit/stdout/stderr comparisons matched, including review normalization and reflection records |
| M10–M12 and auditor | All 6 original self-test suites passed; 89 exit/stdout comparisons matched, plus a mixed Bash/TypeScript contention run proving the lock protocols interoperate on POSIX |

The replacement Bun tests retain the fixtures and dynamic checks, including
concurrent writers, real mutual exclusion, stale locks, caller-provided state,
usage errors and ignored workspaces. Diagnostics may use native filesystem
errors or shorter parser reports; pass/fail and malformed-input statuses remain
separate. Generators name the new command in their output headers.

The schema-replay command is a Docker/Postgres skeleton with no existing live
fixture suite. Its missing-input error and simulated fresh/drift replay verdicts were
compared with Bash; symmetric normalization, migration ordering and cleanup
are also tested natively. A real replay
still needs a consumer's migration set, pinned engine image and Docker daemon.

## Retained shell files

Every remaining `.sh` file is a catalog-parser **input fixture**, not an operated
gate. Those files deliberately contain shell assignment syntax, including
malformed constructs and a CRLF case, which the parser reads without executing.
Changing their language would remove the behavior under test.

Shell snippets in consumer templates remain examples of host wiring. They are
not Groundwork's runnable gate implementations. No Bash gate or self-test
remains in `scripts/`, `audit/` or module `reference/` outside fixtures.

## Reproducing a comparison

The parent revision retains every original implementation. Check it out in a
separate directory, run its self-tests, then run the corresponding new Bun tests
against these same fixtures. The migration's local raw logs are kept in the
ignored `.context/` directory; this document records the scope, baseline and
intentional output difference so those temporary logs are not required to use
the tooling.

## Simplified Technical English linter

The `decide` skill's prose linter,
[`ste-lint.ts`](../plugin/skills/decide/scripts/ste-lint/ste-lint.ts), is a Bun
translation of two Python files: a third-party upstream linter, and the
wrapper that joins wrapped paragraphs before it measures sentence length. Both
Python files ran unmodified under `python3 -I` from a separate directory. Every
input ran through four pairs: the wrapper against the default mode and the
upstream linter against `--raw`, each with `--json` and as the plain report.
Exit codes and standard output were compared byte for byte.

| Input | Files | Findings compared | Result |
|-------|-------|-------------------|--------|
| The reference implementation's decision records, plus the two decision texts its linter tests used | 113 | 11,841 | identical |
| A sample of the reference implementation's other Markdown (every fourth file) | 361 | 27,802 | identical |
| Generated Markdown mixing rule triggers with Unicode letters, digits and spaces, characters outside the Basic Multilingual Plane, tabs, every Python line separator, tables, nested lists, quotes, fences and front matter | 400 | 8,255 | identical |
| Command-line cases: standard input, several files, `--baseline`, `--disable`, empty input, a byte-order mark | 20 runs | | identical |

Findings are counted over the two JSON runs of each file. The translation has
no intentional difference. The rate per 100 words needs Python's `round(x, 1)`,
which rounds the exact binary value and breaks a true tie to the even digit;
114,696 generated rates matched. The selftests keep their checks, with neutral
example sentences of the same word counts.

The compared corpora are the reference implementation's content and are not
committed. The skill's tests keep the Python output for each neutral fixture as
a golden file in `plugin/skills/decide/__tests__/fixtures/ste-lint/`, and the
translation must reproduce each one byte for byte.
