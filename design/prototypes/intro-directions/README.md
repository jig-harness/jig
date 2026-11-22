# The introduction page and the site's look: direction round

The round of [#1066](https://github.com/jig-harness/jig/issues/1066): the look
of the new introduction to Jig, one stepped page on jig-harness.dev, and of the
site around it. This directory holds what the round produced and the brief for
the next one. It is a record of directions, not a design bundle landed under
[the rubric](../rubric.md), and it changes no site code; the build is
[#1067](https://github.com/jig-harness/jig/issues/1067).

## What the round decided

- **The pick: Broadside.** On 2026-11-21 Ophir called the Strip board and the
  Broadside "better layouts for the website" and the Broadside "probably the
  best". The Broadside is the picked layout. The Strip board is the runner-up.
- **The figure is not final.** The graphics drew praise overall, and the figure
  needs a second drawing before the page is built. [figure-brief.md](figure-brief.md)
  is that brief.
- **Step 3 changes.** The original capacity treatment named exact numbers and
  several accounts. The next design records capacity without either claim (see
  the figure brief).
- **The headline** leaves out the words "software factory"
  ([design/website.md](../../website.md#the-message-the-delivery-line)).

## The four directions that were rendered

Eight contracts were written, four by Claude and four by Astra
([contracts/](contracts/)). Four were rendered as artboards in a Design canvas
([canvas/](canvas/)): a first screen, one step in the page and the figure frame,
each on desktop in light and on a phone in dark. They preserve the direction
comparison as it was rendered; they are not the current copy or figure brief.

| Row | Direction | Made by | Idea |
|-----|-----------|---------|------|
| A | Neatline | Astra | an atlas sheet: a sticky plate beside a scrolling legend |
| B | Sheet Set | Astra | a drawing set: a full sheet with a title block for each step |
| C | Strip board | Claude | an operations room: five strips on a rail, read across |
| D | Broadside | Claude | a tool catalogue: poster-size serif, numbered entries, key caps |

Timetable, Plates, Barline and Fieldbook were written and not rendered.

## Why the Broadside

Ophir's words above are the reason. These are the points in the renders that
bear on the build; they are an assessment from the renders, not Ophir's:

- It keeps the site's serif headings and the plain voice, so the page still
  reads as Jig's workshop manual.
- Each step carries its own figure at large scale, which suits a figure that
  changes from step to step.
- A person's moments (merge, answer) are a key cap, a shape no agent step wears,
  so they survive greyscale.
- Planned work is a dagger with a footnote, also greyscale-proof.
- Its desktop and phone hero and step frames were assessed in the round. The
  closing figure frame was assessed on desktop only.

## Token plan for the Broadside

No new token, no new hue, no web font. Every value is one of the site's tokens
in the [round brief](briefs/brief.md#fixed-do-not-reopen).

| Part | Plan |
|------|------|
| Type | the serif stack alone, in bold, roman and italic, with old-style numerals; the sans stack only for the 14px navigation and skip link; no monospace |
| Scale | headline 72px bold on a 1.02 line, its second sentence 48px (38px and 25px on a phone); step titles 40px bold, 32px for the current step and 28px for a neighbour on a phone; labels 18px italic; body 19px; the step numeral 120px for the current step and 72px for a neighbour |
| Ink | `--ink` for text and rules, `--muted` for a quiet neighbour, `--bg` for the page |
| Rules | a thick-thin rule (2px, a gap, 0.5px) in `--ink` between entries; neighbour numerals in `--line-strong`, allowed only at 56px and above where 3:1 holds |
| Key cap | face `--accent-soft`, border `--accent`, a heavier bottom edge, small capitals; for Merge, Answer and the closing "You merge." |
| Planned | a dagger after the title and a footnote under the entry, in italic |
| Links | `--accent`, underlined; focus `--focus` |
| Motion | the closing "You merge." goes from a faint impression to full ink in 240ms; under reduced motion it is inked from the start |

Risks the render workers found, to settle in the build: bold Georgia is wider
and heavier than Iowan or Palatino, so titles may wrap to three lines; no system
serif has true small capitals, so the key caps' small capitals are synthesised;
the 0.5px half of the double rule may draw as 1px; the closing key cap on a phone
needs a check at 320px.

## The figure

The figure is a motion-kit scene on the isometric kit
([figure/](figure/)): an ink engraving on warm paper with hatching and one
green. Two frames exist, both superseded in content by the figure brief but
useful as the style reference: the line, and two slots with the wall. The gate
passes every scene rule. One style rule fails: the style's `emphasis` colour
cannot reach 3:1 against both paper and green, which no palette colour can
satisfy, and the figure never draws `emphasis`. That needs a change in
motion-kit.

To regenerate the frames from a motion-kit checkout that has the isometric kit:

```sh
node figure/render.mjs --motion-kit <path to motion-kit> --no-png
```

Without `--no-png` the script also renders a PNG contact sheet and needs Chromium:
pass `--chromium <path>` or set `JIG_CHROMIUM`.

## Files

| Path | What |
|------|------|
| [figure-brief.md](figure-brief.md) | the brief for the next session: the figure and step 3 |
| [retrospective.md](retrospective.md) | what the method said and what happened |
| [briefs/](briefs/) | the round brief, the render brief and the artboard format notes |
| [contracts/](contracts/) | the eight direction contracts and their briefs |
| [canvas/](canvas/) | the rendered artboards, as the Design canvas holds them |
| [figure/](figure/) | the scene, its style and the frames |
