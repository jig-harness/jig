# The decision sheet

A decision sheet is an HTML view of an `escalated` call. It shows the
question, the hidden branches, the options with their costs, and an outcome
matrix of options against scenarios. A human reads it to make a call that
spans several stakeholders or several options. The outcome matrix shows
what prose hides: two options can mirror each other, each failing the same
way in opposite scenarios, and a text that lists the options one by one does
not make that visible.

The sheet is a projection. The **decision source** is one JSON file, and the
renderer makes three outputs from it:

- the HTML sheet, which goes to the issue as an attachment
- a short issue comment that gives the overview and points to the sheet
- the full markdown elaboration, with the content of the human-call-elaboration format (every option with keep, pay, right-when and obligation). Its headings are fixed by the renderer: it is a generated reference document, so the format's length discipline (no headings under ~500 words) governs hand-written text only

All three come from one source, so the text and the visual cannot drift
apart. The decision record stays canonical. A sheet never replaces it, and a
human's answer still lands as a `human-decided` record.

## Contents

- [When to make a sheet](#when-to-make-a-sheet)
- [The decision source](#the-decision-source)
- [References to an option or a call](#references-to-an-option-or-a-call)
- [Choose the layout](#choose-the-layout)
- [Render and check](#render-and-check)
- [Post the sheet](#post-the-sheet)
- [Regenerate after a ruling](#regenerate-after-a-ruling)
- [What the renderer guarantees](#what-the-renderer-guarantees)

## When to make a sheet

Make a sheet for an `escalated` verdict when any one of these is true:

- the escalation carries two or more `hitl:<stakeholder>` facets
- a call has three or more live options
- a human asks for one

Below that threshold, the text is enough. Do not make a sheet. The script
applies the rule, so do not judge it by eye. `<skill-dir>` is the directory of
the `decide` skill (`${CLAUDE_SKILL_DIR}` in `SKILL.md`):

```bash
bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts trigger --facets technical,product --options 4
# {"sheet":true,"reasons":["2 stakeholder facets","a call with 4 options"]}
```

`--facets` takes the stakeholder names alone (`technical`, not the facet label
`hitl:technical`), so the command works whatever label
`issue_tracker.labels.hitl` names. Pass `--options` once, with one count per
open call (`--options 3,2,2`). Add `--human-asked` when a human asked. Above the threshold, the sheet goes out
**at escalation time**, with the escalation. Nobody has to ask for it.

A sheet costs real effort. On one register of five decisions, each one took
two research agents, two architect passes and the framing: about 500k to 700k
subagent tokens and 30 to 45 minutes. That cost is why the threshold exists.

## The decision source

Write the source as JSON with `"schema": "decision-sheet/v1"`. Keep the
working copy in `.context/decide/<issue-key>/decision.json` (keep `.context/`
out of version control). The rendered sheet
embeds the source, so the attachment is the durable copy. The typed shape is
`scripts/decision-sheet/source.ts`. Its validator rejects unknown fields, so
a misspelt field fails loudly instead of dropping a claim.

| Field | What it holds |
|---|---|
| `id`, `url`, `title` | The issue key and URL of the issue that carries the call, and the question as a title |
| `owners` | The `hitl:<stakeholder>` facets, without the prefix (`technical`, `product`) |
| `priority`, `reversibility` | Title-block fields. Reversibility says what can be undone and what cannot |
| `verifiedAt` | `{ date, commit, repositories? }`: the day and the commit at which the facts were checked. `repositories` maps the name of each other repository the sheet cites to the commit its facts were checked at (see [Cite another repository](#cite-another-repository)) |
| `question` | The question in canonical vocabulary |
| `currentBehaviour` | What the system does now. Each claim has a `source`: a repository-rooted path (`path#symbol`, `path:12-40`), an issue or an ADR |
| `settled` | Optional. Ground that is already decided and is not reopened |
| `hiddenBranches` | Optional. A fact that can change which options apply, each with a next action |
| `calls` | One or more calls. See below |
| `interplay` | How one call shrinks or sharpens another. Required with two or more calls. `from` and `to` are free text: a call id, another decision, an issue or an ADR |
| `myRead` | The overall recommendation. It shows only while a call is still open |
| `glossary` | Optional. Each domain term, defined once |

Each call has an `id` (`a`, `b` …) and two or more `options`. With two or
more calls, each call also needs a `title` and a `question`. Optional call
fields:

- `owners`: a subset of the decision's owners
- `facts`: claims with sources, as in `currentBehaviour`
- `scenarios` and `outcomeMeaning`: the matrix columns, and what each outcome
  kind means for this call
- `subQuestions`: follow-on questions with one answer per option
- `notes`, `openInput`
- `recommended` with `why`: the recommended option, and the reason
- `ruling`: set only after a human rules. See
  [Regenerate after a ruling](#regenerate-after-a-ruling)

Each option has `id`, `name`, `summary`, `keep`, `pay` and `rightWhen`, and
optionally a `tag` and an `obligation`. Leave out an absent `obligation`.
Never write "none". When the call has scenarios, each option has one outcome
per scenario. The outcome vocabulary is fixed: `safe`, `risk`, `human` and
`neutral`. Each one renders as an icon and a word, so colour is never the
only signal.

Write every text field by the writing rules that `SKILL.md` § Phase 4 links.
The source is the text that a human reads.

## References to an option or a call

When a text names an option or a call, write a reference token. Do not write
the name in plain words and hope the renderer links it. A pattern over prose
is always one example behind: "keep 1 year" would link to option 1, and the
citation "(c)" in a statute would link to call (c).

| Token | Means | Reads as |
|---|---|---|
| `{opt:3}` | Option 3 of the call that holds the text | option 3 |
| `{call:c}` | Call c | (c) |
| `{call:c,opt:1}` | Option 1 of call c | (c) option 1 |

The token reads as plain words in the markdown, in the comment and on the
compact sheet. On the document sheet it is also a link, and it traces the
option or call across the page. Write the token where the words would go:
`choose {opt:4}` reads "choose option 4". The token is lowercase, so do not
start a sentence with it.

- Inside a call, `{opt:3}` means that call's option. Outside any call it is
  allowed only in a source with one call. With several calls, name the call:
  `{call:a,opt:3}`. This applies to `interplay`, `myRead`, `hiddenBranches`
  and every other text of the decision itself.
- `parseSource` rejects a token that names an option or a call that does not
  exist, a token that is malformed, and a token in a field that is an id, a
  title, a name, a tag, a label, a citation, a glossary term or meaning, the
  priority or the reversibility. In a source with one call, `{call:c}` has no
  target, so it is rejected too: use `{opt:N}`.
- An issue key with the sheet's own team prefix (`ENG-123` on a sheet whose
  `id` is `ENG-…`) is still found by its pattern, because that shape is
  unambiguous. It links to the issue on the document sheet, built from the
  sheet's `url` (a tracker URL whose path holds `/issue/<KEY>`).
- A source without tokens still renders. It has no option links.

## Choose the layout

`render` takes `--template compact|document`.

| Layout | What it is | Use it when |
|---|---|---|
| `document` (default) | One page set as a report. For a single call the first screen shows the question, the owners, the status, the reversibility, the recommendation and the whole outcome matrix; a source with several calls opens on the overview question and the call index, and each call's matrix sits in its own section below. Hover or focus on an option, a call or an owner traces it across the page. A reader can pick one option for each open call, add a note to each pick, and copy the picks as text | The reader is a human who must decide. This is the layout for almost every sheet |
| `compact` | The drawing sheet: panels with grid references, one sheet for each call and an overview | The author asks for it |

Both layouts read the same source. The markdown elaboration and the comment do
not depend on the layout. The document sheet records its layout in the
embedded source block (`data-template="document"`). A sheet without that
attribute is a compact sheet.

A reader can also write a note on each pick; the note belongs to that option and
joins the copy text under its pick line. The picks and their notes on a document sheet are kept in the reader's browser, for each
decision id. They are not a ruling. The decision record stays canonical. The
copy text names each pick by call id and option id, for example
`(b) option 1: Evict by age, cap the memory`, so the record of a ruling
never needs a guess. After a ruling, the regenerated sheet drops every stored
pick for a ruled call.

## Render and check

```bash
bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts render .context/decide/ENG-123/decision.json --require-fresh
bun <skill-dir>/scripts/ste-lint/ste-lint.ts .context/decide/ENG-123/ENG-123-comment.md .context/decide/ENG-123/ENG-123-elaboration.md
```

`render` takes `--template compact|document` and defaults to `document`.
It writes three files: `<id>-decision-sheet.html`, `<id>-comment.md` and
`<id>-elaboration.md`. They go to
`.context/decide/<id>/` at the repository root, where `<id>` is the source's
`id`, or to the directory that `--out` names. It prints a summary with the
template, the trigger result, the freshness result and the attachment fields to
upload.

`--require-fresh` refuses to render, with exit code `3`, when the guard
cannot run at all (no git checkout, or `verifiedAt.commit` is unknown to this
clone), and in two more cases:

- a file that the source cites changed between `verifiedAt.commit` and the
  working tree
- a cited path does not exist at that commit, so the guard cannot check it.
  Every file name with an extension, every directory path and every
  extensionless path with a directory part (`services/web/Dockerfile`) in a
  `source` counts, with or without a trailing slash once it has a directory
  part. A single-segment directory such as `services` reads as a prose word,
  so write it `services/`. A bare `ADR-NNNN` resolves to its file in the ADR
  directory (`adr.directory`, else detected as `/jig:adr` does). Cite repository-rooted paths. A citation may follow `(`,
  `[`, a quote or a separator. A path with a space in it goes in backticks,
  as `.run/Backend Dev.run.xml`.
  Keep the `source` field to citations. A prose word with a dot, such as
  `e.g.` or `Node.js`, or a pair such as `and/or`, also reads as a path and
  blocks the render.

Re-verify each claim that cites a changed file, update `verifiedAt`, and
render again. The guard knows that a file changed. It cannot know whether a
claim is still true. Only a reader can check that.

### Cite another repository

A sheet whose facts span several repositories qualifies each citation of
another repository with that repository's name: `beta:apps/api/auth.ts#check`,
`beta:apps/api/auth.ts:12-40` or `beta:ADR-0002`. The name is lowercase
(letters, digits, `-` and `_`, starting with a letter) and is followed by a
colon and then a path or an ADR, never an issue key. A path may start with a
digit (`beta:2026/auth.ts`); a number alone after the colon is a line suffix
(`file.ts:12`), never a qualifier. In backticks the name goes inside
them, and the path there may contain spaces, even in a first segment
that starts with a digit:
`` `beta:.run/Backend Dev.run.xml` ``, `` `beta:2026 Auth.ts` ``. An unqualified citation always
means the repository the guard runs in, so two repositories that both number
their ADRs from `ADR-0001` never read each other's file.

Each qualified name needs two things, or the source is refused:

- A commit in `verifiedAt.repositories`, because a commit of this repository
  says nothing about another one's history:

  ```json
  "verifiedAt": {
    "date": "2026-10-20",
    "commit": "4f2a9c1",
    "repositories": { "beta": "9be01d7" }
  }
  ```

- A clone, configured in `.config/jig.yaml` under `sheets.repositories`
  ([CONFIGURATION.md](../../../CONFIGURATION.md#procedure-skills)), as a path
  relative to this repository's root or absolute. The clone must hold the
  recorded commit and be current, since the guard compares each cited file
  at that commit with the clone's working tree.

  ```yaml
  sheets:
    repositories:
      beta: ../beta
  ```

A qualified citation whose name has no recorded commit, and a `name:` placed
like a qualifier that the rules above do not accept (`Beta:ADR-0002`,
`beta:ENG-123`, `beta:` outside the backticks), make the source invalid:
`validate` and `render` both refuse it with exit code `1`, as for any other
source error. A name with no configured clone, a clone that is missing or is
not the top of a git clone, and a recorded commit the clone lacks fail
`validate` (it checks the clone only inside a git checkout) and make
`render --require-fresh` exit `3`. Changed and unresolved files of another
repository are listed with their qualifier. An unqualified path that is not in
this repository stays unresolved and blocks `--require-fresh`; qualify it, or
cite it by name in the prose, which the guard does not check.

Fix each linter flag in the source, not in the rendered file, and render
again.

## Post the sheet

Attach the sheet first. Then remove every older sheet. This order means a
failed upload never leaves the issue with no sheet. Use the `attachment`
fields from the `render` summary.

Attachments go through the harness's own integration with the issue tracker:
the plugin's tracker scripts post comments but do not upload files. The steps
below are the Linear (MCP) adapter example; with another tracker, keep the
order and the checks and use its equivalent calls.

1. Call `mcp__linear__prepare_attachment_upload` with `issue`, `filename`,
   `contentType`, `size`, `title` and `subtitle`.
2. Upload the bytes within 60 seconds. Send every header in
   `uploadRequest.headers` exactly as it was returned:
   `curl -sSf -X PUT --data-binary @<sheet.html> -H '<name>: <value>' … '<uploadRequest.url>'`.
3. Call `mcp__linear__create_attachment_from_upload` with `issue`,
   `assetUrl`, `title` and `subtitle`. Note the new attachment id. If the
   call fails, for example with a 502, call `mcp__linear__get_issue` first.
   When the attachment is not there, repeat this step with the same
   `assetUrl`: a retry with the same `assetUrl` has succeeded after a 502.
4. Call `mcp__linear__get_issue` for the issue. Write its result to a file
   and pass it to
   `bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts stale-attachments --keep <new-id> < issue.json`.
   Delete each id that it prints with `mcp__linear__delete_attachment`. The
   script refuses if the new attachment is not on the issue.
5. Post `<id>-comment.md` as a comment on the issue (`SKILL.md` § Tracker
   operations).

A tracker such as Linear serves an attachment as a download. The comment
tells the reader to open the file in a browser. Never commit a sheet to the
repository.

## Regenerate after a ruling

When a human rules on a call, post the `human-decided` record first. It is
the canonical outcome. Then make the sheet show the ruling (Linear adapter
example, as above):

1. Call `mcp__linear__get_issue` and find the attachment whose title starts
   with `Decision sheet: `. Call `mcp__linear__get_attachment` with its `id`
   and `format: "url"`. The URL is signed for five minutes. Download it at
   once: `curl -sSfL -o current.html '<url>'`.
2. Recover its source and its layout. Create the directory first: a fresh
   session has no `.context/decide/<issue-key>/`, and the shell opens the
   redirect target before `extract` runs:
   `mkdir -p .context/decide/ENG-123 && bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts extract current.html > .context/decide/ENG-123/decision.json`.
   Then read the layout of the posted sheet:
   `bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts template current.html`.
   It prints `compact` or `document`.
3. Add `ruling` to the call that was decided:
   `{ "option": "<id>", "recordUrl": "<link to the human-decided comment>", "ruledAt": "YYYY-MM-DD" }`.
   Do not change the other calls. Open calls stay open.
4. Render with `--require-fresh` and the same `--template` that step 2 printed
   (`--template "$(bun <skill-dir>/scripts/decision-sheet/decision-sheet.ts template current.html)"`),
   and post as in [Post the sheet](#post-the-sheet), but skip step 5. The
   `human-decided` record is the comment for this change. Attachment
   replacement finds the old sheet by its title, so it works whatever layout
   the old sheet had. The issue ends with one sheet attachment.

The regenerated sheet shows the decided call with the chosen option, the
date and a link to the record. It drops that call's recommendation. The
status in the title block follows from the rulings. The overall "my read"
disappears once every call is ruled.

## What the renderer guarantees

The tests in `__tests__/` (`decision-sheet.test.ts`,
`decision-sheet-document.test.ts` and the browser test below) pin each of
these:

- **No claim absent from the source.** Every word on the sheet comes from
  the source or from the fixed label table in
  `scripts/decision-sheet/labels.ts`. A label names a slot and states no
  fact.
- **Self-contained.** No external font, script, stylesheet or image. The
  embedded source is an inert `application/json` block, and every text field
  is HTML-escaped.
- **Complete matrix.** Every option has one cell per scenario. A missing
  cell fails validation.
- **One options region and one matrix per call.** On the compact sheet, one
  call gives one sheet, and two or more calls give an overview sheet with the
  call index and the interplay panel, then one sheet per call. On the document
  sheet, every call is a section of one page, behind a call index.
- **The compact layout is stable.** Its output for a source without
  reference tokens is byte-identical to a stored copy
  (`__tests__/fixtures/decision-sheet/pilot.compact.html.txt`), so a change
  made for the document layout cannot alter it.
- **References are explicit.** No pattern over prose links an option or a call.
- **Pilot parity.** The pilot fixture
  (`__tests__/fixtures/decision-sheet/pilot.json`) renders every claim of the
  stored pilot sheet.
- **Contrast.** The colours are the sheet kit's own neutral palette
  (`scripts/sheet-kit/html.ts` and `css.ts`). The outcome colours meet the
  4.5:1 text contrast minimum of the Web Content Accessibility Guidelines
  against white. On the document sheet, every text on a tint meets that
  minimum: the ink on each outcome tile is darker than a mid-lightness step of the same
  hue, because such a step does not reach 4.5:1 on its own tint.
- **A document sheet works without a script and in print.** With JavaScript
  off, and in print, all content is visible. Only the Pick controls, the tray
  and the time left need a script. Every hover has the same effect on keyboard
  focus and shows a focus state. The sheet makes no network request and logs no
  console error. The pilot fixture's sheet stays at or under 60 kilobytes, and its first screen
  at 1440 x 900 shows every matrix row. The top bar fits or wraps from 1024 px
  up. A browser test holds each of these (`decision-sheet-browser.test.ts`). It
  needs Google Chrome: where Chrome is missing it skips and says so, and with
  `JIG_REQUIRE_BROWSER=1` a missing browser fails the run instead.

## The sheet kit

The reading system of the `document` layout is not specific to decisions:
the frame, cited claims in the margin, terms in place, issue links, the top
bar, print, escaping, the validator primitives and the freshness guard. It
lives in `scripts/sheet-kit/`, and the explainer sheet of
[`/jig:explain`](../../explain/SKILL.md) uses it too. There is one copy:
`explain` imports it by a relative path (`../../decide/scripts/sheet-kit/`),
because the skills ship together in one plugin and a sibling skill's
directory is always beside this one. A change to the kit changes both sheet
genres at once; run both skills' tests.

The decision stylesheet and script interleave kit fragments and decision
rules in cascade order, so the kit holds them as exact named fragments that
the document template interpolates where they always stood. Extract only
what both genres use; a piece one genre needs stays in its template.
