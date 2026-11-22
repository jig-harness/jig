# Retrospective: the introduction page's direction round

Written for needle-eye's log: copy it there as
`2026-11-21-jig-intro-directions.md` and amend the skills named below. It follows
that repository's template.

- **Surface:** the introduction page and the site's look, issue
  [#1066](https://github.com/jig-harness/jig/issues/1066); the artefacts are in
  [README.md](README.md).
- **Date:** 2026-11-21.
- **Written by:** the session that ran the round (Claude). Ophir picked the
  Broadside, with the Strip board as runner-up.
- **Skills used:** `needle-eye:direction`, `needle-eye:model-routing` and
  `needle-eye:checks`, version 0.1.0; `needle-eye:astra-drawing` was not run,
  Astra wrote contracts only.

## What the method said, and what happened

| Skill and section | What it said | What happened | Evidence |
|---|---|---|---|
| direction, The round, steps 1-2 | Eight contracts, then a person picks four | The issue asked to show rendered directions before asking, so the coordinator chose four of eight for spread in layout, type and motion. Ophir saw four rendered directions only | [contracts/](contracts/) |
| direction, Write a contract | Forbid opening the current surface; assign a reference world and a constraint; fixed field order; difference in kind | Both writers kept to it; the eight differ in layout, type and motion | [contracts/claude-contracts.md](contracts/claude-contracts.md), [contracts/astra-contracts.md](contracts/astra-contracts.md) |
| direction, Render one direction | Three artboards, verbatim copy, workers do not render | Each worker wrote five artboards (a first screen and a step at two widths, and the figure frame); none rendered, as told. The coordinator rendered them | [briefs/render-brief.md](briefs/render-brief.md), [canvas/](canvas/) |
| model-routing, Who does what | Claude writes, Astra writes contracts too, a person picks | Astra ran on a Codex home as `gpt-6.2-astra` and wrote four contracts in one pass | [contracts/astra-contracts.md](contracts/astra-contracts.md) |
| checks, Layer 1 | The motion-kit gate checks structure | It passed every scene rule and refused the style on one contrast pair no palette can satisfy | [README.md](README.md#the-figure) |
| checks, Layer 2 | Look at the output | The coordinator rendered every artboard in Chromium and found a clipped label in the Strip board hero, which was fixed | [canvas/stripboard-hero-1440.dc.html](canvas/stripboard-hero-1440.dc.html) |
| checks, Layer 3 | A person signs off | Ophir picked on 2026-11-21 and sent figure feedback the gate and the looks had not raised | [figure-brief.md](figure-brief.md) |

## What worked

- A shared round brief with the fixed facts, the verbatim copy and the three
  artboards, read by contract writers, the figure worker and the render workers
  alike, so the four directions differed in layout and type and not in words
  ([briefs/brief.md](briefs/brief.md)).
- Giving each contract writer an assigned reference world and one assigned
  constraint in a table, before writing: the eight contracts differ in kind
  ([contracts/claude-assignments.md](contracts/claude-assignments.md)).
- One shared figure for all directions, so the directions are compared on the
  page's design and the drawing is judged once.
- Converting the artboards to plain pages and rendering them locally before the
  canvas was opened caught a clipped label that no worker could see.

## What did not work

- The contracts were chosen and rendered with a draft figure whose content was
  wrong: the line was a closed loop, the queue was missing, the item was a plain
  box and the wall named numbers and accounts. Ophir found this on sight. The
  method has no step that checks the figure's story against how the thing works
  before directions are rendered around it.
- The draft copy for the steps, written by the coordinator, carried claims
  ("Two slots per account") that Ophir ruled out. Copy that a person has not
  approved was rendered into every direction.
- The Design canvas type told the coordinator not to check its own work; the
  method's Layer 2 says to look. The coordinator looked anyway, locally. The
  canvas renders only in its own runtime, so a local check needs the artboards
  converted first.
- A render worker's artboard (Strip board, step 2 on the 1440 board) cut off a
  neighbour; the worker flagged it, and it was not fixed.

## What the checks caught, and what they missed

- Caught: the gate refused a style whose `emphasis` pair cannot pass; the local
  render found a clipped label.
- Missed by every check: the figure's story. A person saw it in one look.

## Amendments made

None here. The amendments below go into needle-eye in its own pull request.

| Skill and section | Change | The practice behind it |
|---|---|---|
| direction, The round | Add a step before contracts: a person approves the figure's story and the copy as text, or a rough storyboard of the figure, so directions are not rendered around content that is wrong | [figure-brief.md](figure-brief.md) |
| direction, Render one direction | Say that a coordinator may choose the rendered four when the task asks to show before asking, and name the criterion (spread in layout, type, motion) | [README.md](README.md#the-four-directions-that-were-rendered) |
| checks, Layer 2 | Add the way to render a Design canvas artboard locally: strip the wrapper, swap image addresses for local files, screenshot in Chromium | this round, the coordinator's conversion script (not kept; the steps are in the sentence) |

## Candidates, not yet practice

- Showing the figure's states as a numbered storyboard in text before any is
  drawn.
- Letting the direction workers read the previous round's pick, so a later round
  starts from it.

## Open questions

- Whether the next round renders the Broadside alone with the new figure or the
  Broadside and the Strip board side by side.
- Whether motion-kit's style gate should let a style mark a token unused, so the
  `emphasis` pair does not block export.
