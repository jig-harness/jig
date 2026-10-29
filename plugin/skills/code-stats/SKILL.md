---
name: code-stats
description: "Measure a repository: classify every tracked file by area, kind, language and module, count its lines of code, and report the totals in the terminal, as JSON or as an interactive HTML report; explain why one file was classified as it was."
argument-hint: "[--json | --html [out.html] | --explain <path>]"
allowed-tools: "Read Bash(bun *) Bash(git *)"
---

# Code stats: what the repository is made of

How much of this repository is shipped product code, and how much is tests,
tooling, agent [scaffolding](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
docs, build or ops, and in which language and module? This skill answers
that without a one-off script. It classifies every tracked file along the
[code-stats dimensions](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) and counts its bytes and lines:

- **area**: what the file is *for* (`scaffolding`, `ci`, `build`, `database`,
  `ops`, `tools`, `docs`, `repo-config`, `production`, or the repository's
  own list);
- **kind**: what the file *is* (`code`, `test`, `docs`, `config`, `data`,
  `generated`, `fixture` (a [test fixture](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)), `asset`, `vendored`,
  `other`);
- **language**: from the extension, a shebang line (`#!/usr/bin/env bash`)
  or the `linguist-language` [git attribute](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md);
- **module**: from the [workspace manifests](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (pnpm, npm, Yarn or Bun
  workspaces, `go.work`, Cargo, Gradle, uv), or the top folders.

Lines are counted as blank, comment or code:
[LOC (lines of code)](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) are the
non-blank, non-comment lines. Binary and media files are sized but not
line-counted. The human's page is [README.md](README.md); it lists every
built-in rule.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository you are measuring. Never
`cd` into the skill directory: the script finds the repository and its
configuration from the working directory (or `JIG_CONSUMER_ROOT`).

## When to use it

- Someone asks how big the repository is, what it is made of, the test to
  code ratio, how much is generated, or how large the agent scaffolding is.
- Before or during an audit, as measured evidence (`--json`).
- To check why a file counts where it does (`--explain`), or to tune a
  repository's `code_stats` configuration until the unclassified share is
  small.

Do not use it for coverage or complexity: it counts lines, it does not run
or parse the code.

## Commands

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/code-stats.ts"                    # terminal summary
bun "${CLAUDE_SKILL_DIR}/scripts/code-stats.ts" --json             # aggregates as JSON
bun "${CLAUDE_SKILL_DIR}/scripts/code-stats.ts" --html [out.html]  # interactive report
bun "${CLAUDE_SKILL_DIR}/scripts/code-stats.ts" --explain <path> [--json]
```

`--top N` sets how many modules the terminal summary lists (15).
`--include-vendored` counts vendored files, which are left out of every total
by default; each output says how many were left out.

- **Terminal**: the headline numbers, the unclassified share, then tables by
  area, kind, language and module. Summarise it for the user; do not paste
  it whole.
- **`--json`**: `schema: code-stats/v1`, then `totals`, `unclassified`,
  `vendored`, `areas`, and `byArea`, `byKind`, `byLanguage`, `byModule`,
  `byAreaKind` (keys `<area>/<kind>`), each value a bucket of `files`,
  `bytes`, `raw`, `code`, `comment`, `blank`. The shape is in the
  [README](README.md#the-json-report); a breaking change is a new schema.
- **`--html`**: one self-contained file that works offline, written to
  `.context/code-stats/code-stats.html` under the repository root unless a
  path is given (keep `.context/` out of version control). It lists every
  file path, so do not publish it without asking. Give the user its path.
- **`--explain <path>`**: each dimension of one tracked file and the rule or
  detector that set it, for example
  `kind: test — convention: Go *_test.go` or
  `area: build — default area rule "build", build tool: Cargo (glob "**/build.rs")`.

Exit 0 is success, 1 means the report could not be made (the message says
why), 2 is a command line the script cannot act on.

## Reading the unclassified share

A file is **unclassified** when its kind is `other` or no area rule matched
it, so it fell to the default area (`production` unless configured). Every
output shows the share of files and of LOC. With the default areas, product
code outside the conventional folders falls through to `production` and
counts as unclassified: a large share means the repository's layout needs a
`code_stats` section, not that the numbers are wrong.

## Test-runner configuration

Before the `code_stats` configuration, the skill reads what the
repository's test runners declare, as text and without running anything:
jest's `testMatch`, `testRegex` and `roots`; vitest's `test.include` and
`test.exclude`; pytest's `testpaths` and `python_files`; Gradle's `test`
source set folders; Maven's `testSourceDirectory` and its `src/test/java`
default. A code file one of them names is a test, and `--explain` names
the reader, file and key, for example
`kind: test — test runner jest: jest.config.js testMatch "**/*.check.js"`.
A configuration that exists only when it runs (a function, a spread, a
folder built in code) is reported as `unreadable: <path> (<why>)` in the
terminal summary, `--explain` and `--json` (`testRunners.unreadable`), and
nothing is claimed from it. Report such a line to the user; when its tests
matter, `code_stats.kinds` names them. A tracked file the file system
refuses to read stops every mode with `cannot read <path> (<code>)`; report
it, do not work around it. The [README](README.md#test-runner-configuration)
lists what each reader reads and cannot read.

## Fixing a weak classification

Detect first, set a value where detection is wrong, supply a command as a
last resort. Use `--explain` on a few misclassified files to see which rule
decided, then, in the repository's `.config/jig.yaml`:

1. **`code_stats.areas`**: an ordered list of `{name, description, paths,
   content}`; the first match wins and the list replaces the defaults, so
   copy the defaults you want to keep (they are listed in the README).
   `content: true` makes YAML and JSON in that area count as data.
2. **`code_stats.default_area`**: the name for files no area matches.
3. **`code_stats.kinds`**: `{<kind>: [globs]}`, checked before built-in
   detection and the test runners' configuration, in the order written.
4. **`code_stats.modules`**: globs naming module folders, replacing the
   manifests.
5. **`code_stats.classify_command`**, only when globs cannot say it: a
   [classify command](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), a shell
   command that reads the tracked paths on standard input, one per line, and
   prints JSON lines `{"path", "area"?, "kind"?, "language"?, "module"?}`
   whose values override every other layer.

Every field is in the
[configuration reference](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#code_stats).
Re-run and compare the unclassified share.

## Fail closed

A failed `git ls-files`, `git check-attr` or classify command is an error,
never an empty report. A configuration with an unknown kind, a malformed
glob, a duplicate area name or a value of the wrong type is refused with a
message naming the field and the file that set it. So is classify-command
output that is not a JSON object per line, names an untracked path, or gives
an unknown area or kind. Paths reach the command one per line, so with a
command configured, a tracked path that holds a newline is refused. The command has 300 seconds
(`JIG_CODE_STATS_COMMAND_TIMEOUT_SEC`). Report such an error to the user as
it is; do not work around it.

## Known limit

Tests written inside production files (Rust `#[cfg(test)]` modules, Python
and Elixir doctests) count as production code: splitting them would mean
parsing each language.
