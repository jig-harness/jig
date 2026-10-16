# Generator coverage: the inputs a generator reads are the inputs that exist

Part of [M2 Generated-artifact freshness](../../README.md).

A [freshness gate](../../../../GLOSSARY.md) proves one thing: the committed
artifact equals what the generator writes. It cannot see an input the
generator never reads. A route the application mounts but the spec generator
does not stub, a migration outside the replay's list, a module a roster
omits: each is absent from the artifact, the artifact is fresh, and nothing
fails. The omission surfaces when a consumer of the artifact misses the
thing, long after the change that caused it.

So a generator that selects its inputs by a list it maintains gets a second
check, over the lists: the set of inputs that exist equals the set the
generator reaches. A generator that walks its inputs (every file under a
directory) reaches them by construction and needs none.

`check-generator-coverage.ts` compares two name lists and fails when they
differ. It only compares; the enumerations are the caller's.

## Usage

```bash
bun check-generator-coverage.ts [--generator <name>] <existing> <reached>
```

- `<existing>`: the inputs that exist, one name per line, enumerated from
  where they live (a directory listing; a grep over the application's
  registrations).
- `<reached>`: the inputs the generator reads, one name per line, enumerated
  from the generator's own list.
- `--generator`: the generator's name, for the findings.
- `#` at the start of a line or after whitespace starts a comment, so a name
  may contain one; blank lines and surrounding whitespace are ignored, a
  name listed twice counts once. One of the two lists may be `-` for
  standard input.

Both enumerations must be complete, or the check fails open on exactly the
input it exists to notice: an enumeration that reads only the first name of a
compound expression (`if (a && b)`) drops every name after it. Enumerate with
a parser or a depth-aware scan, never with a pattern that stops at the first
delimiter, and keep the enumerations beside the generator so a change to how
inputs are declared changes them too.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`,
`files.ts`, `findings.ts`) by their path from the repository root
(`../../../../lib/`), so run it from a pinned Jig checkout, or vendor it
with `lib/` keeping that relative layout (or rewrite the imports), as the
toolchain note in
[M1's mappings](../../../M1-gates-enforcement-ladder/mappings.md) describes.

## Findings

Every difference is reported, not only the first:

- an input that exists and is not reached: the artifact silently omits it,
  and the fix is to add it to the generator's list or to retire the input;
- a name the generator reads that no longer exists: a stale entry, which
  hides the next omission among the noise; the fix is to remove it or to
  restore the input.

Findings print as `(repository): [generator-coverage] problem` and
`fix: remedy` lines, and under GitHub Actions also as annotations
([`lib/findings.ts`](../../../../lib/findings.ts)).

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | the two sets are equal: `generator-coverage: OK — <name> reaches every one of <n> input(s)` |
| 1 | an input is unreached, or a reached name does not exist |
| 2 | a list cannot be read, or holds no name: an enumeration that found nothing is a wrong path, not a generator without inputs |

## Wiring it into CI

One line per generator that keeps a list, beside that generator's freshness
check; in a repository with a [generated-file inventory](../inventory/), as
part of the entry's `check` command, so it runs wherever the freshness check
runs and a generator cannot ship without it:

```yaml
check: >-
  bun tools/check-spec-fresh.ts &&
  ls routes/ | sed 's/\.ts$//' > /tmp/existing &&
  bun tools/generate-spec.ts --list-inputs > /tmp/reached &&
  bun reference/generator-coverage/check-generator-coverage.ts --generator generate-spec.ts /tmp/existing /tmp/reached
```

The reached list comes from the generator itself (`--list-inputs` prints the
names its run reads, from the same list it iterates), never from searching
its source text: a search also finds a name in a comment or in dead code, so
an input the run never reads would count as reached and the check would pass
over the very omission it exists to catch.

## Try it

```sh
cd fixtures
bun ../check-generator-coverage.ts existing.txt reached-all.txt          # exit 0
bun ../check-generator-coverage.ts existing.txt reached-missing-one.txt  # exit 1, an unreached input
bun ../check-generator-coverage.ts existing.txt reached-stale.txt        # exit 1, a stale entry
bun ../check-generator-coverage.ts existing.txt empty.txt                # exit 2, could not check
```

The self-test beside the script, `check-generator-coverage.test.ts`, runs
every fixture pair, the standard-input form and the usage errors.
