# Required-sections gate

Each pipeline stage produces a **named artifact from a committed template** — a
[PRD](../../../../GLOSSARY.md), an architecture doc, a research note. A template
is only real if the artifact keeps its required headings, so the next stage can
rely on finding them. This gate reads a markdown artifact and a list of required
section headings, and fails if any is absent.

## Why it exists

"Use the template" is a convention until something checks it. Without a gate, a
PRD quietly ships with no `## Success metrics`, an architecture doc with no
decisions section — and the omission is only noticed a stage later, when the
missing part was exactly what the next stage needed. This makes the
committed-template rule mechanical: the required headings are declared once (a
manifest per artifact type) and enforced on every changed stage doc.

## Mechanism

Two inputs: the artifact, and the required heading labels.

| Input | How it is supplied |
|-------|--------------------|
| artifact | arg 1, or `ARTIFACT=` |
| required headings | `SECTIONS=` (a list, one per line or `\|`-separated) — wins when set; else a manifest file (arg 2 / `MANIFEST=`), one label per line, `#` comments ignored |

Labels are plain heading text (`Success metrics`), not `## Success metrics`. A
label matches any Markdown heading (a `#`-prefixed line) in the artifact whose
text is equal after trimming whitespace, dropping the `#` markers and a trailing
colon, and lowercasing.
A heading counts only where it renders as a section: headings inside fenced or
indented code blocks, HTML comments and the frontmatter block are ignored. The match is deliberately
forgiving on formatting so the gate flags a genuinely absent section, not a
capitalisation difference.

```sh
SECTIONS='Problem statement|Success metrics|Scope' bun ./check-required-sections.ts prd.md
bun ./check-required-sections.ts prd.md sections.txt
```

## Where it runs

A per-artifact check on **changed stage docs** — wire one invocation per artifact
type (a PRD manifest, an architecture manifest, a research-note manifest) so a
PR that touches `docs/prd/*.md` runs the PRD manifest against it.
[CI](../../../../GLOSSARY.md) is the authority (see
[M1](../../../M1-gates-enforcement-ladder/)); per-forge wiring is in
[`mappings.md`](../../mappings.md).

## Files

| File | Role |
|------|------|
| `check-required-sections.ts` | the gate; artifact via arg/`ARTIFACT`, headings via `SECTIONS`/manifest |
| `check-required-sections.test.ts` | paired self-test (exit codes + case-insensitive matching + the named-miss output) |
| `fixtures/sections.txt` | a PRD sections manifest |
| `fixtures/good-prd.md` | all required sections — must pass |
| `fixtures/bad-prd.md` | missing `## Success metrics` — must fail |
| `fixtures/frontmatter-heading.md` | `## Success metrics` only inside a frontmatter block scalar — must fail |
| `fixtures/html-comment-heading.md` | `## Success metrics` only inside an HTML comment — must fail |
| `fixtures/indented-heading.md` | `## Success metrics` only in an indented code block — must fail |
| `fixtures/empty-sections.txt` | comments only — must error (exit 2) |

Exit codes: 0 every required heading present, 1 a heading missing (the output
names it), 2 a usage or input error (no artifact, file not found, no required
headings given).

Run the self-test with `bun test ./check-required-sections.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.
