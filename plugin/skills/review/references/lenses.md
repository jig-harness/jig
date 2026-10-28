# The lens step

## Contents

- [What a lens is](#what-a-lens-is)
- [1. Select](#1-select)
- [2. Write each brief](#2-write-each-brief)
- [3. Run each lens with fresh context](#3-run-each-lens-with-fresh-context)
- [4. Summarize](#4-summarize)
- [The lens file](#the-lens-file)

Read this when Tier 3 reaches its lens step. Every command runs from the
root of the repository under review, with `<session>` from setup, and
`<skill-dir>` stands for the directory holding this skill's `SKILL.md`.

## What a lens is

A [review lens](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
is one check taught to a reviewer, held in one Markdown file. The plugin
ships [seed lenses](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
in `<skill-dir>/lenses/`, each the review form of one rule a Jig module
states (`jig.swallowed-failure` enforces M15's rules on failures); a
repository keeps its own in the directory `review.lenses.dir` names, read
from the base snapshot. Each lens runs only when the diff gives it
something to check, and every lens is comment-only: a finding's effective
severity is at most `WARNING`.

## 1. Select

```sh
bun --no-env-file --config="<skill-dir>/scripts/bunfig.toml" "<skill-dir>/scripts/review.ts" lenses "<session>"
```

Append `--lens=<id>` once per lens the caller named with `--lens`: it runs
that lens whatever its trigger or `review.lenses.off` says. The helper runs
`select-lenses.ts` inside the base snapshot with the enumerated environment
and prints one line per lens: `run` or `skip`, the lens as `id@version`,
and why (the first path and line that matched, `no trigger matched`, `off`,
`--lens`, or `proposed` for a lens file the change adds, which is reviewed
as part of the diff and never run). A nonzero exit is a configuration error
(an id that names no lens, a pattern that is not a regular expression, a
repository lens with the `jig.` prefix, a lens file that does not parse):
stop the review and report the error as the helper names it.

## 2. Write each brief

For each lens that runs:

```sh
bun --no-env-file --config="<skill-dir>/scripts/bunfig.toml" "<skill-dir>/scripts/review.ts" brief "<session>" "<lens id>" "<earlier-findings file>"
```

The last argument is a file holding Tier 1's and Tier 2's findings, so the
lens does not report what a gate already did; leave it out under
`--tier=3`, when there are none. The helper prints the path of the brief: the
lens file, the effective diff, the touched files by absolute path, the
base snapshot's instruction files, and the shape findings come back in.

## 3. Run each lens with fresh context

Each lens is its own reviewer, so one lens's conclusion does not steer
another's. Use the first of these the harness offers:

1. **Subagents.** One subagent per lens, all started at once, each told to
   read its brief and follow it. Claude Code's Agent tool is one.
2. **The harness's agent command, run non-interactively.** One run per
   lens, started inside the base snapshot with the enumerated environment
   and the brief on its standard input, so the harness takes its project
   settings and instruction files from the base branch, never from the
   reviewed tree:

   ```sh
   bun --no-env-file --config="<skill-dir>/scripts/bunfig.toml" "<skill-dir>/scripts/review.ts" agent "<session>" "<brief>" claude -p --add-dir "<reviewed root>"
   ```

   Another harness's command goes in place of `claude -p` (Codex's is
   `codex exec -`, which reads the prompt from standard input). The
   reviewed files are read by absolute path as data, so the command needs
   read access to the reviewed root (`--add-dir` above). Credentials the
   command keeps under the home directory reach it; one held only in an
   environment variable does not, since the run gets the enumerated
   environment. The run is cancelled after 30 minutes.
3. **The same session.** Run each brief in turn yourself, and say in the
   summary that the lenses shared one context.

Each run returns a JSON array of findings, `[]` when there is none. Collect
them into one list.

## 4. Summarize

Write a JSON file with the path of the selection the helper saved
(`lenses.json` in the folder that holds `<session>`), the findings, how the
lenses ran, and the other tiers' results, then run:

```sh
bun "<skill-dir>/scripts/summarize-lenses.ts" "<summary input>"
```

```json
{
  "selection": "<absolute path of lenses.json>",
  "runner": "subagents | command | same-session",
  "findings": [],
  "semantic": "APPROVED | REJECTED | NONE",
  "tier1": "PASSED | BLOCKED",
  "tier2": "PASSED | WARNINGS | BLOCKED"
}
```

`semantic` is how Tier 3's other reviews ended, `NONE` when no semantic
trigger fired. When `--quick`, `--tier=1`, `--tier=2` or `--skip-t3` ran no
lens, give `"skipped_by": "<the flag>"` in place of `selection`. It prints
Tier 3's line, the `Lenses:` line, the verdict, and each finding with its
effective severity: capped at `WARNING`, since no lens is promoted to
blocking, and `INFO`, marked unverified, when its evidence field is empty.
Copy the lines into the summary as printed.

## The lens file

Frontmatter (`id`, `version`, `rules`, `lever`, `trigger` with `paths`,
`exclude`, `added_lines` and `removed_lines`, `evidence`), then the body's
`## Look for`, `## Not a finding` and `## Evidence` sections. A seed lens's
id starts with `jig.`; a repository lens keeps its `LENS-NNN` number and
may not use that prefix. `review.lenses.triggers` appends to a lens's own
patterns and never replaces them.
