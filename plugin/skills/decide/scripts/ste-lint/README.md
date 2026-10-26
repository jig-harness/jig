# Simplified Technical English linter

Advisory linter for text that asks a human to decide. It checks the
structural rules of [Simplified Technical English](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
short sentences, active verbs, no semicolons, one word for one action. The
rules it checks, and how to use it, live in one place:
[`human-call-elaboration.md` § Writing rules](../../references/human-call-elaboration.md#writing-rules-for-text-that-asks-a-human-to-decide).

```bash
bun "<skill-dir>/scripts/ste-lint/ste-lint.ts" draft.md
bun "<skill-dir>/scripts/ste-lint/ste-lint.ts" draft.md --json
```

Flags: `--json` prints the report as JSON, `--baseline N` passes the run
while hard findings stay at or below `N`, `--disable rule,rule` drops rules,
`--selftest` runs the built-in checks, and `--raw` runs the upstream linter
alone (one physical line at a time, without the corrections below). The exit
code is `1` when hard findings exceed the baseline, and `0` otherwise.

## Files

| File | What it is |
|---|---|
| `ste-lint.ts` | The linter: the upstream rules, then the local wrapper around them. |
| `LICENSE` | The upstream copyright and permission notice. Keep it with `ste-lint.ts`. |

## Provenance

- Source: [`danyuchn/asd-ste100-skill`](https://github.com/danyuchn/asd-ste100-skill),
  `scripts/ste-lint.py`, skill version 0.4.0, commit `7d4a135`. Copyright (c)
  2026 Dustin Yuchen Teng; the licence text is in `LICENSE`, beside this file.
- `ste-lint.ts` is a TypeScript translation of two Python files: that upstream
  linter, unmodified, and a local wrapper written around it. The rules,
  regular expressions, severities, messages, synonym groups, flags, JSON
  output and exit codes are the same. The plugin ships no Python, so the
  translation replaces both files.
- The translation reproduces the Python output exactly. The comparison is
  recorded in
  [`scripts/migration-parity.md`](https://github.com/jig-harness/jig/blob/main/scripts/migration-parity.md#simplified-technical-english-linter),
  and the Python output for each test fixture is kept as a golden file in
  `../../__tests__/fixtures/ste-lint/`.
- To take an upstream change: translate it into the upstream section of
  `ste-lint.ts`, record new golden files with the Python linter, and update the
  commit above.

## Why a wrapper

Upstream measures sentence length one physical line at a time, so it misses
every long sentence in a hard-wrapped Markdown file. The wrapper runs upstream
twice. On the original text it keeps every finding except `long-sentence`. On
the joined text (each paragraph on its first physical line, the rest emptied)
it keeps only `long-sentence`. A `long-sentence` finding reports the first line
of its paragraph.

Other rules match upstream except for the corrections below. They sit around
the upstream rules, which stay as upstream wrote them.

- **Fences.** Upstream toggles a boolean on any line that starts with three
  backticks or tildes. The wrapper blanks each fenced region first, by the real
  rule (same character, at least the opening length), so both passes skip the
  same lines. A fence can open after a quote or list marker and ends with its
  container. A rejected opener (backtick in a backtick info string) is prose,
  and the wrapper removes its run so upstream does not take it for a delimiter.
- **Hedges.** Upstream protects `may have` only when exactly one space
  separates the two words on one line. The wrapper also protects a wrap or an
  adverb between them (`may already have`), including across quote and list
  prefixes, wrapped lines in one paragraph, and table cells.
- **Synonym rotation.** Two verbs from one group do not prove they name one
  action. The wrapper reports the finding as advice, so it never raises the
  exit code.

An upstream pull request with the join step is outward-facing. Ask a human
first.

## Advisory only

No CI workflow, hook, package script, gate, plugin manifest or validation
plan may call this linter on authored text.
`../../__tests__/ste-lint.test.ts` fails if a wiring file names it. That scan
does not follow a script that a wiring file delegates to. The skill's test
suite does run the linter, on fixtures only.
