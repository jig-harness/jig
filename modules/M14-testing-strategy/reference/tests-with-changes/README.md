# Tests come with changes

A gate that fails a change when a source file it adds or modifies has no
test, unless the file is registered as exempt with a reason. It turns "new
code comes with tests" from a review habit into a check that runs in a hook
and in [CI](../../../../GLOSSARY.md).

Without it, the rule erodes one reasonable-looking exception at a time: a
helper "too small to test", a file an agent wrote quickly, a refactor that
moved logic into a new module nobody tests. With it, every such file is
either tested or listed, and the list is a reviewed file with a reason on
each line.

## What it checks

For each changed path that matches a source glob:

1. a path that has the shape of a test (it matches a test template) is a
   test, not a source, and needs nothing;
2. a path matched by an exemption needs nothing;
3. otherwise one of the test paths the templates name for it must exist as
   a regular file (with `--require-changed`, it must also be part of the same
   change). A directory or a symbolic link at that path does not count, and
   neither does a file reached through a linked directory: git records a
   link, not the files it points at, so following one on disk would let the
   two modes disagree.

In a test's shape, `{ext}` is one extension without a dot, as it is when a
test path is made. So with `{dir}/{name}.test.{ext}`,
`src/orders.test.helpers.ts` is not a test but a source, and needs its own.
A placeholder used twice stands for the same text both times, in a test path
and in a test's shape: with `{dir}/{name}/{name}.test.{ext}`,
`src/orders/orders.test.ts` is a test and `src/orders/helpers.test.ts` is a
source. A template may hold one `{dir}` or `{dir:FROM=TO}` at most; a second
is a usage error. The text a placeholder stands for is inserted as written,
never read as a placeholder again: `src/{ext}.ts` needs `src/{ext}.test.ts`,
not `src/ts.test.ts`.

| Argument | Meaning |
|----------|---------|
| `--base <ref>` | read the change from git: paths added, copied, modified, renamed or changed in type (a symbolic link replaced by a file) since the merge base of `<ref>` and `HEAD`; tests are looked up in `HEAD` |
| `--changed <file>` | read the changed paths from a file, one per line (`-` for standard input); tests are looked up on disk under `--root` (default `.`) |
| `--source <glob>` | which paths are source; repeat for several; an empty glob is a usage error |
| `--test <template>` | where a source file's test lives; repeat for several; an empty template is a usage error. `{dir}`, `{name}` and `{ext}` are the source's directory, its file name without the last extension, and that extension; `{dir:FROM=TO}` is the directory with a leading `FROM` replaced by `TO` (`{dir:src/main/java=src/test/java}`), and gives no test path for a source outside `FROM` |
| `--exemptions <file>` | lines of `<glob> <reason>`; blank lines and `#` comments are ignored, and a line without a reason is an error |
| `--require-changed` | the test must change with the source, not merely exist |

Exit codes: `0` every changed source has a test or an exemption, `1` at
least one has neither (each is listed with the paths that were looked for),
`2` a usage error (including an empty glob or template), an exemption without a reason, or git failing. A change
the gate could not read never passes.

Deleted files need no test. A pure move is a rename, so the moved file is
checked at its new path.

## Running it

```sh
bun check-tests-with-changes.ts --base origin/main \
  --source 'src/**/*.ts' \
  --test '{dir}/{name}.test.{ext}' \
  --test '{dir}/__tests__/{name}.test.{ext}' \
  --exemptions .config/test-exemptions.txt
```

The layout for Python, Go and JVM projects is in the module's
[mappings](../../mappings.md#tests-come-with-changes). In a pre-push hook,
`--base` is the branch the change will merge into; in CI it is the pull
request's base commit, fetched with enough history to find the merge base.

## Exemptions

An exemption names a path pattern that needs no test and says why, on one
line:

```text
# <glob> <reason>
src/generated/** Generated from the schema; the generator has its own tests.
src/config/*.ts Configuration values only; the loader's tests read them.
src/**/__tests__/** Test helpers and fixtures beside the tests; they are test code.
```

The glob ends at the first space, so a path pattern cannot contain one; match
such a path with a wildcard (`docs/release?notes/**`) instead.

Test helpers that live in a test directory but are not themselves named like
a test (`__tests__/helpers.ts`, `__tests__/fixtures/**`) match the source
globs without matching a template's shape, so exempt the test directories as
in the last line above.

Keep it short and reviewed: every line is a place the rule does not reach. An
exemption file is a registered escape hatch in the sense of
[M1](../../../M1-gates-enforcement-ladder/README.md), so list it in the
suppression-token registry beside the inline tokens.

The gate checks that every exemption has a reason. It does not check that an
exemption still matches anything: one left behind by deleted code passes, and
it would exempt new code later created at that path. Until the gate prunes
stale exemptions (future work in [M14](../../README.md#future)), remove an
exemption in the same change that removes what it excused.

## What it does not judge

It proves that a test file exists, not that the test exercises the change.
Pair it with the module's other rules: a new test is seen to fail before its
pass is trusted, and test files are type-checked.

## Files

| File | Role |
|------|------|
| `check-tests-with-changes.ts` | the gate |
| `check-tests-with-changes.test.ts` | self-test: list and git modes, exemptions, `--require-changed`, usage errors, template expansion including a swapped directory, the shape of `{ext}`, a directory or link at the test path or a linked directory above it, and a link replaced by a source file |
| `fixtures/` | a small source tree with tested, untested and generated files, and two exemption files |

Run the self-test with `bun test ./check-tests-with-changes.test.ts`. The gate
imports `lib/cli.ts` from Jig's root (`../../../../lib/cli.ts`), so run it from
a pinned Jig checkout. To vendor it instead, copy `lib/cli.ts` with it and
change that import to where the copy lives; `lib/cli.ts` has no imports of its
own.
