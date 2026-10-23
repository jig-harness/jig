---
name: explain
description: "Write a sourced how-it-works explainer sheet: when someone must understand how a part of the system works today, render the explanation as a cited, dated HTML sheet plus markdown, for a decision, a review or onboarding."
argument-hint: "<what to explain> [<issue-key> it serves]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
  - Edit
  - Task
---

# Explain — a sourced explainer sheet

Someone must understand how a part of the system works today: to make a
decision, to review a change, or to start work in an unfamiliar area. Long
prose in an issue comment or a chat is hard to check and hard to read. An
explainer sheet is the same content as a typed source: a summary with its
scope, the flow as numbered steps, detail claims grouped in sections, open
questions and terms. Every step and every claim carries a citation, and the
facts are dated to a commit.

The renderer turns the source into two projections:

- an HTML sheet: one self-contained file that works offline, without
  JavaScript and in print, with each citation in the margin beside its claim
- a markdown text with the same content, for a comment or a chat

It is the second sheet genre on the sheet kit. The first is the decision
sheet of [`/jig:decide`](../decide/SKILL.md). Both share the reading
system (layout, citations, terms in place, the top bar, print) and the trust
rules: the renderer adds only fixed labels, every claim has a citation, and a
freshness guard compares the citations against `verifiedAt.commit`.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository the explainer describes.
Never `cd` into the skill directory: the scripts find the repository, its
history and its configuration from the working directory, or from
`JIG_CONSUMER_ROOT` when it is set. The scripts import
the sheet kit from the sibling `decide` skill
(`${CLAUDE_SKILL_DIR}/../decide/scripts/sheet-kit/`), which the `jig`
plugin always installs beside this one.

### Consumer configuration

The skill reads these optional fields from `.config/jig.yaml`
at run time:

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `explain.figure_build_command` | The command that builds one figure; the skill runs it with the figure's stem as the last argument | No figure build: write explainers without figures |
| `adr.directory` | Where a bare `ADR-NNNN` citation resolves for the freshness guard | Detected as `/jig:adr` does (`docs/adr`, `doc/adr`, `docs/decisions`, …), else `docs/adr` |
| `decide.glossary_file` | The repository's canonical vocabulary | `CONTEXT.md` |

## When to make one, and when plain text is enough

Make an explainer when any one of these is true:

- a decision needs a "what the system does now" part longer than about ten
  sentences, so the decision sheet can link to it instead of carrying it
- the explanation has an order that matters (a flow of more than three
  steps) and claims a reader will want to check
- the same explanation will be read by several people, or read again later

Plain text is enough when the answer is a few sentences, when nobody needs
to check the claims against the code, or when it only serves the current
conversation. Do not make a sheet for a one-off answer.

An explainer describes the system as it is. It does not propose a change,
and it does not decide anything: a call that needs a ruling goes to
[`/jig:decide`](../decide/SKILL.md). It is not customer-facing
content: a repository's user documentation follows its own policy.

An explainer is for a human reader, and every claim cites its file so that a
reader can check it. A quick orientation map for the agent itself, without
paths and line numbers, is a different artifact; one is a good start for the
explainer's research.

## Steps

1. **Research.** Read the code, not memory. For a large area, hand the
   research to a subagent with the schema below and the rule that every claim
   must be re-verified at `HEAD`. Use the canonical terms from the
   repository's glossary (`decide.glossary_file`, default `CONTEXT.md`), if it
   has one.
2. **Write the source** in `.context/explain/<id>/explainer.json` (keep
   `.context/` out of version control). The format, the step tokens and the
   citation rules are in
   [`references/explainer-sheet.md`](references/explainer-sheet.md).
3. **Validate:**
   `bun "${CLAUDE_SKILL_DIR}/scripts/explainer-sheet/explainer-sheet.ts" validate <source.json>`.
4. **Figures (optional).** A figure is a diagram drawn by
   [Archify](https://github.com/tt-a1i/archify), an open-source tool that
   draws architecture diagrams from typed JSON sources; it is the one diagram
   format supported so far. Check that the diagram
   matches the code before you use it: a wrong figure is worse than none.
   Build it with the repository's figure build
   (`explain.figure_build_command`, with the diagram's stem as the last
   argument). A repository without one writes explainers without figures.
5. **Render for posting:**
   `bun "${CLAUDE_SKILL_DIR}/scripts/explainer-sheet/explainer-sheet.ts" render <source.json> --require-fresh`.
6. **Read the sheet** in a browser. For a sheet that many people will read,
   have a second reader review it before posting.
7. **Post** the sheet to the issue it serves, with the markdown as the
   comment (procedure in the reference).

## Scripts

| Script | Purpose |
|---|---|
| `scripts/explainer-sheet/explainer-sheet.ts` | `render`, `validate` and `extract` |
| `scripts/explainer-sheet/source.ts` | The source schema, validator and `{step:N}` tokens |
| `scripts/explainer-sheet/figures.ts` | The check a built figure must pass before it is embedded |
| `../decide/scripts/sheet-kit/` | The sheet kit, shared with `/jig:decide`: one copy, imported by relative path |
