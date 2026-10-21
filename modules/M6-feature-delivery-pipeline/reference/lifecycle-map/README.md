# Lifecycle map gate

Part of [M6 Feature-delivery pipeline](../../README.md).

A delivery loop that is written down in several places is found in one of
them. A session that designs or changes the process asks "what comes next?" of
whatever it has read, and a skill that no page names is a skill it never
meets: the pass that settles what a merge still owes and the step that closes
an epic can both exist for a long time without anyone being sent to them. A
list of skills grouped by category does not help, because a category says what
a skill is, not when to use it.

The [lifecycle map](../../README.md#the-lifecycle-map) is one table of the
loop's stages. Each row names the owner of the stage and the artifact it hands
on. This gate keeps the map honest in the one way a script can: every owner it
names has to exist.

## What it checks

| Rule | Fails when |
|------|-----------|
| `stage-table` | the file has no table with the columns `Stage`, `Owner` and `Hands on` |
| `stage-name` | a stage has no name, is numbered (`1. steer`, `Stage 2`), or repeats another stage's name |
| `owner-missing`, `handoff-missing` | a stage has no owner, or names it in words only, or has no handoff |
| `placeholder` | a stage's name, owner or handoff, or a row of the table of skills outside the loop, is still a `<placeholder>` from the template |
| `owner-unresolved` | a code span in an owner is not something that exists (below), or a relative link in it reaches no file |
| `skill-not-in-map` | with `--cover`, a skill in that directory owns no stage and is not in the table of skills outside the loop |
| `skill-unresolved` | with `--scan`, a document names a `/namespace:skill` that does not exist |
| `map-not-linked` | with `--linked-from`, the always-loaded instruction file does not link the map |

The gate reads every file as a reader sees it, through Bun's built-in
[CommonMark](https://commonmark.org) parser with GitHub's tables: a table, code span or link inside a
fenced block or an HTML comment is not part of it, and neither is one written
as an example inside a code span or after a backslash. Stages are named, never numbered: a number
is wrong the day a stage is added in the middle. Whether the stages are in the right order is not checked; it is
a question for the reviewer of a change to the process.

A code span in an owner resolves when it is:

- **A skill or command**: `/name`, or `/namespace:name` for a plugin's
  skills. It resolves to `<dir>/<name>/SKILL.md` or `<dir>/<name>.md` under a
  `--skills` directory, each a regular file; a linked skill directory is
  followed. `--skills jig=plugin/skills` serves the `jig`
  namespace; `--skills .claude/skills` (no namespace) serves bare names; a
  second directory of command files is a second `--skills` entry. A
  bare name does not resolve in a namespaced directory, because that is not
  how the skill is invoked.
- **A package script**: `bun run gates`, `npm run`, `pnpm run`, `yarn run`,
  against the `scripts` of `package.json` whose command is text. `bun run`
  also runs a file, so `bun run scripts/check.ts` resolves to the file.
- **A file**: `bun scripts/check.ts`, or a bare path, against `--root`.
- **A declared external command**: anything else the repository trusts to
  exist outside it (`gh`, `bun test`), declared with `--external <command>`.
  A command the gate cannot resolve and nobody declared is a finding, not a
  pass, so it never reads as checked when it was not.

A chain (`a && b`, `a || b`, `a; b`, `a | b`) is resolved command by
command, quoted as a POSIX shell quotes it: an operator inside quotes or after
a backslash stays part of its argument. A link may be inline or a reference
link whose definition is in the map.

Prose in an owner cell that names no span and no link (`whoever is free`) is
a finding too: it cannot be resolved. A stage owned by a person says so with
a link to the document that makes it so, such as the decision that a person
merges.

## Running it

```bash
bun check-lifecycle-map.ts docs/LIFECYCLE.md \
  --skills jig=plugin/skills --skills .claude/skills \
  --cover plugin/skills --linked-from AGENTS.md
```

Exit `0` when every check holds, `1` for a violation (each printed with its
file, line, rule and fix), `2` when the map, a `--scan` file, a `--cover`
directory or `package.json` cannot be read, or the options are wrong. All
options:

| Option | Meaning |
|--------|---------|
| `--root <dir>` | where files and `bun <path>` are looked up; the working directory by default |
| `--skills [namespace=]<dir>` | a directory of skills or command files, with the namespace they are invoked under; repeatable |
| `--package-json <file>` | the package file; `<root>/package.json` by default |
| `--external <command>` | a command that lives outside the repository; repeatable |
| `--cover <dir>` | require every skill in the directory to appear in the map |
| `--scan <file>` | require every `/namespace:skill` the file names, for a namespace given to `--skills`, to exist; repeatable |
| `--linked-from <file>` | require the file to link the map |

`--scan` reads inline code spans outside code blocks and comments, and only for a
namespace the gate was given, so a bare `/tmp` or a command in another tool's
namespace is never a finding. Leave out of the scan the documents that name
skills that are not built yet (a plan) or no longer exist (a changelog); that
is a choice for the wiring, like the one in Jig's own
[`scripts/check-lifecycle-map.ts`](../../../../scripts/check-lifecycle-map.ts).

## Where it runs

It reads files only, so it runs in the repository's fast gate set beside the
other documentation checks, locally and in CI; CI is the authority
([M1](../../../M1-gates-enforcement-ladder/README.md)). The recipe is in
[`mappings.md`](../../mappings.md#the-lifecycle-map).

## Files

| File | Role |
|------|------|
| `check-lifecycle-map.ts` | the gate |
| `markdown.ts` | what a reader sees of a document: its tables, code spans and links, and the line each is on |
| `check-lifecycle-map.test.ts` | paired self-test: every rule, the options and the exit codes |
| `fixtures/repo/` | a small repository: skills, a command, a package, a good map, the instruction file that links it and one that does not |
| `fixtures/repo/maps/` | maps that each break one rule |

Run the self-test with `bun test ./check-lifecycle-map.test.ts`. The gate
imports Jig's [`lib/`](../../../../lib/) (the argument parser and the finding
format), so a repository adopting it runs it from a pinned Jig checkout or
vendors `lib/` with it.
