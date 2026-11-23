# Retrospective: the introduction page's direction round

Record of what the round's method asked for, what happened, what worked, what
did not, and what to adjust in future rounds.

- **Surface:** the introduction page and the site's look, issue
  [#1066](https://github.com/jig-harness/jig/issues/1066); the artefacts are in
  [README.md](README.md).
- **Date:** 2026-11-21.
- **Written by:** the session that ran the round (Claude). Ophir picked the
  Broadside, with the Strip board as runner-up.
- **Method used:** independent direction contracts, a multi-model authoring
  split (Claude and Astra; Astra wrote contracts only and did not draw), and
  layered checks (structural gate, rendered visual check, human sign-off).

## What the method asked for, and what happened

| Stage | What the method asked for | What happened | Evidence |
|---|---|---|---|
| Selecting directions to render | Eight contracts, then a person picks four | The issue asked to show rendered directions before asking, so the coordinator chose four of eight for spread in layout, type and motion. Ophir saw four rendered directions only | [contracts/](contracts/) |
| Writing contracts | Forbid opening the current surface; assign a reference world and a constraint; fixed field order; difference in kind | Both writers kept to it; the eight differ in layout, type and motion | [contracts/claude-contracts.md](contracts/claude-contracts.md), [contracts/astra-contracts.md](contracts/astra-contracts.md) |
| Rendering directions | Three artboards, verbatim copy, workers do not render | Each worker wrote five artboards (a first screen and a step at two widths, and the figure frame); none rendered, as told. The coordinator rendered them | [briefs/render-brief.md](briefs/render-brief.md), [canvas/](canvas/) |
| Authoring split | Claude writes, Astra writes contracts too, a person picks | Astra ran as `gpt-6.2-astra` and wrote four contracts in one pass | [contracts/astra-contracts.md](contracts/astra-contracts.md) |
| Structural gate | The figure gate checks structure and style rules | It passed every scene rule and refused the style on one contrast pair no palette can satisfy | [README.md](README.md#the-figure) |
| Visual check | Look at the rendered output | The coordinator rendered every artboard in Chromium and found a clipped label in the Strip board hero, which was repaired before review | [canvas/stripboard-hero-1440.dc.html](canvas/stripboard-hero-1440.dc.html) |
| Human sign-off | A person signs off | Ophir picked on 2026-11-21 and sent figure feedback the gate and the looks had not raised | [figure-brief.md](figure-brief.md) |

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
  visual check step says to look. The coordinator looked anyway, locally. The
  canvas renders only in its own runtime, so a local check needs the artboards
  converted first.
- A render worker's artboard (Strip board, step 2 on the 1440 board) cut off a
  neighbour; the worker flagged it, and it was not resolved in the render.

## What the checks caught, and what they missed

- Caught: the gate refused a style whose `emphasis` pair cannot pass; the local
  render found a clipped label.
- Missed by every check: the figure's story. A person saw it in one look.

## Process changes for future rounds

| Stage | Change | The practice behind it |
|---|---|---|
| Before contracts | Add a step before contracts: a person approves the figure's story and the copy as text, or a rough storyboard of the figure, so directions are not rendered around content that is wrong | [figure-brief.md](figure-brief.md) |
| Rendering directions | Say that a coordinator may choose the rendered four when the task asks to show before asking, and name the criterion (spread in layout, type, motion) | [README.md](README.md#the-four-directions-that-were-rendered) |
| Visual check | Document how to render a Design canvas artboard locally: strip the wrapper, swap image addresses for local files, screenshot in Chromium | this round, the coordinator's conversion script (not kept; the steps are in the sentence) |

## Candidates, not yet practice

- Showing the figure's states as a numbered storyboard in text before any is
  drawn.
- Letting the direction workers read the previous round's pick, so a later round
  starts from it.

## Open questions

- Whether the next round renders the Broadside alone with the new figure or the
  Broadside and the Strip board side by side.
- Whether the figure tool's style gate should let a style mark a token unused,
  so the `emphasis` pair does not block export.
