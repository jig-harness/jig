# Generated-file inventory and the one runner

Part of [M2 Generated-artifact freshness](../../README.md).

A [freshness triad](../../../../GLOSSARY.md) per derived file is not enough
on its own: each triad's drift check protects the file only while CI runs
it. When that wiring is one hand-added CI step per generator, the next
generator ships with a check nobody wired, and its artifact rots behind a
green build. So the declaration and the wiring are one thing: every derived
file is declared once, in one inventory, and one generic runner runs every
declared check. A new generator adds an entry, never a workflow step, and an
entry without a check does not parse.

`run-generated-checks.ts` reads the inventory, checks what it can about it,
runs every declared check and reports every result. It only checks; it
regenerates nothing.

## The inventory

One YAML file, in either form. A standalone inventory
([`../../templates/generated-files.yaml`](../../templates/generated-files.yaml)
is a copyable starter):

```yaml
generated:
  - outputs: ["docs/INDEX.md"]
    source: ["docs/**/*.md"]
    command: "bun tools/generate-index.ts docs"
    check: "bun tools/check-index-fresh.ts docs"
    notes: "Navigation, derived from the docs tree."
```

Or a [change-area catalog](../../../M3-change-area-catalog/README.md)
(module M3), where the same entries sit on the area that owns the files, as
its `generated:` list; then the catalog couples each artifact to its area
and the regenerate command lives in one place rather than in a hook, a CI
step and a paragraph of prose:

```yaml
areas:
  docs:
    title: "Documentation"
    paths: ["docs/**"]
    generated:
      - outputs: ["docs/INDEX.md"]
        source: ["docs/**/*.md"]
        command: "bun tools/generate-index.ts docs"
        check: "bun tools/check-index-fresh.ts docs"
```

An entry's fields, all paths relative to the directory the runner runs from:

| Field | Meaning |
| --- | --- |
| `outputs` | the committed files the generator writes; each is declared once in the whole inventory |
| `source` | globs of the files whose change calls for a regeneration; each must match a repository file, so a mistyped source cannot silently stop the coupling from firing |
| `command` | regenerates the outputs; the runner never runs it, it is the fix a failing check names |
| `check` | exits 0 when the outputs are fresh and 1 when they are stale; a triad's drift check, a lockfile's frozen install, a byte comparison |
| `notes` | optional: what the file derives and the check's limits |

Any other field is refused, so a misspelt field cannot drop a command
unnoticed.

## Usage

```bash
bun run-generated-checks.ts [--list] <inventory.yaml>
```

Run it from the repository root: the commands run there, and the outputs and
sources resolve from there. `--list` prints every entry and runs nothing.

The script imports helpers from the Jig repository's `lib/`
(`bounded-shell.ts`, `cli.ts`, `files.ts`, `findings.ts`, `record.ts` and
the vendored YAML parser) by their path from the repository root
(`../../../../lib/`), so run it from a pinned Jig checkout, or vendor it
with `lib/` keeping that relative layout (or rewrite the imports), as the
toolchain note in [M1's mappings](../../../M1-gates-enforcement-ladder/mappings.md)
describes.

## What one run does

1. **Reads the inventory**, in either form, and refuses one it cannot read
   as a whole: not YAML, neither form, an entry without one of its required
   fields or with a field it does not know, or nothing declared.
2. **Checks the declarations**: each output is a file and is declared once;
   each source glob matches a repository file (the files git lists under
   the current directory; outside a checkout, a walk); in catalog form, each
   output is matched by its own area's `paths`, so a hand-edit to the output
   selects the area that checks it. Each problem is a finding.
3. **Runs every distinct check once**, in declaration order, through Bun's
   shell, showing its output as it runs. Every check runs whatever the
   earlier ones did, so one run reports every stale artifact, not only the
   first. A check that exits 1 makes a finding per entry that declares it,
   whose fix is the entry's `command`.

Findings print as `place: [generated-files] problem` and `fix: remedy`
lines, and under GitHub Actions also as annotations
([`lib/findings.ts`](../../../../lib/findings.ts)).

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | every check passed and the declarations hold: `generated-files: OK — <n> check(s) passed for <m> declared output(s) …` |
| 1 | a check found its outputs stale, or a declaration does not hold |
| 2 | the inventory cannot be read, or a check could not start or decide |

A check's exit is read as: 0 passed; 1 stale, unless the shell reported that
it found no such command, which is "could not start"; any other exit, a
killed check included, "could not decide". A check that starts and exits 1
reads as stale whatever its reason, so write checks that exit 2 when they
cannot decide, as every Jig gate does. The runner fails closed: input it
could not read, a check it could not run and a check that could not decide
never pass, and a run with such a check exits 2 even when every other check
passed.

## Wiring it into CI

One step, in the workflow that is a required check; a generator added later
needs an inventory entry and nothing here:

```yaml
- name: Every declared generated file is fresh
  run: bun <path to run-generated-checks.ts> .config/generated-files.yaml
```

GitLab CI and the other providers take the same one line
([`../../mappings.md`](../../mappings.md)). Keep the hook leg of the triad
beside it: the runner is the authority, the hook the convenience.

## Try it

Each fixture directory is a tiny repository root with its inventory and its
files, one per outcome:

```sh
cd fixtures/fresh && bun ../../run-generated-checks.ts generated-files.yaml   # exit 0
cd ../stale && bun ../../run-generated-checks.ts generated-files.yaml         # exit 1, the fix is the command
cd ../mixed && bun ../../run-generated-checks.ts generated-files.yaml         # exit 2, every check reported
cd ../catalog && bun ../../run-generated-checks.ts --list catalog.yaml        # the catalog form, listed
```

The self-test beside the script, `run-generated-checks.test.ts`, runs every
fixture and the parser's refusals. Jig's own derived files are declared in
its change-area catalog and `bun run gates` runs their checks through this
runner ([CONTRIBUTING.md](../../../../CONTRIBUTING.md)).

## What it leaves to the team

The runner proves the declared files fresh; it cannot know about a derived
file nobody declared. The inventory is where a reviewer asks "is this file
generated?" and the generated-file header in each output
([`../triad/`](../triad/)) is what warns a hand-editor; a file that can
carry no header (a lockfile, a vendored build) has its entry as its marker.
Which checks run on every pull request and which only when their sources
changed is the pipeline's choice ([M13](../../../M13-pipeline-economy/README.md)):
the runner runs what it is given.
