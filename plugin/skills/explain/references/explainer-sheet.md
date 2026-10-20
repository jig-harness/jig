# The explainer sheet

An explainer sheet is an HTML view of how a part of the system works today.
It is a projection. The **explainer source** is one JSON file, and the
renderer makes two outputs from it: the HTML sheet, and a markdown text with
the same content. Both come from one source, so they cannot drift apart.

The worked example is `order-checkout`: how a fictional online shop's checkout
prices and charges an order today. It is the test fixture at
`<skill-dir>/__tests__/fixtures/explainer-sheet/order-checkout.json`, where
`<skill-dir>` is the directory of the `explain` skill (`${CLAUDE_SKILL_DIR}`
in `SKILL.md`). Read it as the worked example.

## Contents

- [The source](#the-source)
- [References to a step](#references-to-a-step)
- [Citations](#citations)
- [Figures](#figures)
- [Render and check](#render-and-check)
- [Post the sheet](#post-the-sheet)
- [What the renderer guarantees](#what-the-renderer-guarantees)

## The source

```json
{
  "schema": "explainer-sheet/v1",
  "id": "order-checkout",
  "title": "How an online shop's order checkout works today",
  "url": "https://tracker.example.com/acme/issue/ENG-123",
  "verifiedAt": { "date": "2026-10-04", "commit": "4f2a9c1e07" },
  "summary": "One paragraph: the whole mental model in short.",
  "scope": { "covers": ["…"], "excludes": ["…"] },
  "figures": [{ "id": "checkout-flow", "title": "…", "caption": "…", "diagram": "docs/diagrams/checkout-flow.workflow.json" }],
  "flow": [{ "id": "1", "title": "…", "text": "…", "source": "path/to/file.ts#symbol" }],
  "sections": [{ "id": "kebab-id", "title": "…", "intro": "…", "claims": [{ "text": "…", "source": "…" }] }],
  "openQuestions": ["…"],
  "terms": [{ "term": "…", "meaning": "…" }],
  "related": [{ "text": "ENG-123: the decision this explainer supports", "url": "https://…" }]
}
```

Required: `schema`, `id` (kebab-case), `title`, `verifiedAt`, `summary`,
`scope.covers`, and at least one section with at least one claim. Everything
else is optional; leave a key out rather than empty. An unknown key is an
error.

- **Order builds understanding.** The sheet shows the summary and scope
  first, then the figures, then the flow, then the detail sections, then the
  open questions, terms and related links. Write in that order: overview
  before detail.
- **`flow`** is the ordered path through the system, at least two steps.
  Step ids are short (`1`, `2`, … are best).
- **`sections`** group the detail claims, one fact per claim. An `intro` is
  one sentence that says which steps the section refines.
- **`openQuestions`** are not claims and carry no citation. Name the issue
  that tracks each one.
- Write in the style of Simplified Technical English: short sentences, one
  fact per sentence, active voice, canonical terms from the repository's
  glossary (`decide.glossary_file`, default `CONTEXT.md`), if it has one.

## References to a step

A text names a flow step with `{step:N}`. The sheet shows it as "step N", a
link that lights the step on hover and on focus; the markdown shows "step N".
Tokens are allowed in the summary, the scope, step text, section intros,
claim text, figure captions and open questions. Anywhere else (an id, a
title, a citation, a term) a token is an error, because those fields show
text as it is. A token for a step that does not exist, or a malformed one
such as `{ step : 1 }`, is an error.

## Citations

Every flow step and every claim has a `source`. Cite repository-rooted paths
with a symbol: `src/checkout/pricing.service.ts#buildQuote`.
Several citations go in one `source`, separated by `; `. `ADR-NNNN` and an
issue key such as `ENG-123` count too. Prefer `#symbol` to line numbers, which move. Each
segment may carry a trailing ` (note)`. `validate` and `render` refuse any
other segment, such as prose, so every citation names something the freshness
guard can check.

The freshness guard is the sheet kit's, shared with the decision sheet. It
reads every path in every citation, and the diagram source of every figure,
and compares each one against `verifiedAt.commit`. A clean result means no
cited file changed; it does not mean the claims are true, and the render
summary says so (`freshnessScope`). A bare `ADR-NNNN` resolves to its file
in the ADR directory (`adr.directory`; when it is not set, the directory
`/jig:adr` detects, else `docs/adr`). The citation rules
of the decision sheet apply unchanged
([`decision-sheet.md`](../../decide/references/decision-sheet.md#render-and-check),
section "Render and check"). That includes the qualified form for a citation
of another repository: `beta:ADR-0002` or `beta:apps/api/auth.ts#check`, with
the commit in `verifiedAt.repositories` and the clone in
`sheets.repositories` ([Cite another
repository](../../decide/references/decision-sheet.md#cite-another-repository)).
A bare `ADR-NNNN` always means this repository.

## Figures

A figure is a diagram drawn by [Archify](https://github.com/tt-a1i/archify), an
open-source tool that draws architecture diagrams from typed JSON sources
(`<dir>/<stem>.<type>.json`, where the type is `architecture`, `workflow`,
`sequence`, `dataflow` or `lifecycle`). It is drawn as a static vector image
(`svg` markup) inside the sheet. Its text is real text, so find-in-page reaches it. Its words come from
the diagram source, not from the explainer source; the caption names that
source, and the freshness guard checks it.

1. Use a diagram source in the repository, or add one. **Check it against the
   code first.** A diagram drawn for an earlier design can look right and
   describe behaviour the code no longer has.
2. Build it with the repository's figure build
   (`explain.figure_build_command`, given the stem). It writes
   `<stem>.figure.svg` next to the diagram source: the drawing that Archify's
   renderer made, with only the style rules its classes need, scoped under
   `#fig-<stem>`, every element id prefixed, and the SHA-256 of the diagram
   source in `data-source-sha256`. The build should fail when a class has no
   style rule, so an Archify upgrade cannot silently produce a black figure.
   Keep the built file out of version control.
3. `render` reads `<stem>.figure.svg` next to the diagram source. It refuses a
   figure that is missing, built from another version of the source, or
   outside the expected format (`scripts/explainer-sheet/figures.ts`).

The viewer's interactivity (guided views, theme toggle) stays out of the
sheet. Link the full viewer page in `related` where it adds value.

## Render and check

```bash
bun <skill-dir>/scripts/explainer-sheet/explainer-sheet.ts render .context/explain/<id>/explainer.json --require-fresh
```

It writes `<id>-explainer.html` and `<id>.md` to `.context/explain/<id>/`, or
to the directory `--out` names, and prints the freshness result and the
attachment fields. `--require-fresh` refuses to render, with exit code `3`,
when a cited file changed since `verifiedAt.commit`, a cited path does not
exist at that commit, or the guard cannot run (`verifiedAt.commit` is unknown
to this clone). Re-verify each claim that cites a changed file, update
`verifiedAt`, and render again.

`extract <sheet.html>` prints the source embedded in a rendered sheet, so a
sheet can be regenerated from the attachment alone.

## Post the sheet

Attach the sheet to the issue it serves, the same way as a decision sheet
([`decision-sheet.md`](../../decide/references/decision-sheet.md#post-the-sheet);
Linear adapter example: `mcp__linear__prepare_attachment_upload` with the
`attachment` fields from the `render` summary, upload the bytes with every
returned header, then `mcp__linear__create_attachment_from_upload`). Remove an
older explainer with the same title after the new one is attached, never
before. Post the markdown as the comment, or a shorter comment that points to
the sheet, through the tracker scripts of `/jig:do-item`
(`<skill-dir>/../do-item/scripts/tracker.ts comment <KEY>`). Never commit a
rendered sheet to the repository.

## What the renderer guarantees

- **No claim absent from the source.** Every word on the sheet and in the
  markdown comes from the source or from the fixed labels in
  `scripts/explainer-sheet/labels.ts`. A figure's words come from its cited
  diagram source.
- **Every step and claim has a citation**, set beside it.
- **Escaping** of every text field, in the sheet and in the markdown.
- **No empty region:** an absent optional field leaves no heading or list.
- **Self-contained:** no network request, no external font, script,
  stylesheet or image. Everything is visible with JavaScript off and in
  print.

The tests in `<skill-dir>/__tests__/` hold each of these.
