# Render one direction (issue #1066 design round)

You render one direction as five artboards in the Design canvas format. Read, in this order:
1. `../briefs/brief.md` (fixed facts, tokens, verbatim copy; the three
   artboards A, B, C every direction delivers).
2. `../briefs/dc-format.md` (how to write a `.dc.html` file).
3. Your contract (named in your assignment): its section in
   `../contracts/claude-contracts.md` or `../contracts/astra-contracts.md`. The contract
   decides type, layout, shape language, colour use, how devices look and the motion moment.
   Work only from these files and the images below. Do NOT open the Jig repository or website.
4. Look at the committed figures in `../figure/` (the engraving manner and the supplied figure).

## The five artboards (write each to `./<prefix>-<name>.dc.html`)

| file | size | theme | content |
|---|---|---|---|
| `<prefix>-hero-1440.dc.html` | 1440 x 900 | light | Artboard A: first screen. Headline, sentence, "Start with an audit", logo, the figure's place (step 1 frame). The first screen must hold the headline, the sentence and the words "You merge" |
| `<prefix>-hero-390.dc.html` | 390 x 844 | dark | Artboard A on a phone, first screen |
| `<prefix>-step-1440.dc.html` | 1440 x (as tall as the layout needs, 900 to 1500) | light | Artboard B: the stepped page showing step 3 "The dispatcher works within capacity" in context: show the position in the five steps (steps 2 and 4 visible as neighbours in their quiet state, at least their numbers/labels/titles), the figure in step 2 frame, the status devices |
| `<prefix>-step-390.dc.html` | 390 x (as tall as needed) | dark | Artboard B on a phone |
| `<prefix>-figure-1440.dc.html` | 1440 x (as needed, 600 to 900) | light | Artboard C: the recurring figure as this direction frames it: crop, scale, caption/labels, and the closing "You merge." with the person's moment device (the page's end). Show step 1 frame |

Each artboard must contain the direction's devices from contract field 9: the step number, the
"planned" mark (carried on step 2, "The tick", whose body is in brief.md; show it on the step
artboard as a neighbour, and on the hero if the contract puts it there), a person's moment vs an
agent's step. The motion moment cannot move in a static artboard: draw its settled state and add a
small caption strip under the artboard content? no: do not add annotation; just draw the settled state.
Put anything you want to tell the coordinator in your final report instead.

## Figure images (use the committed SVGs; set width/height)

Wide frames: `../figure/line-step1-light.svg`, `line-step1-dark.svg`,
`line-step2-light.svg`, and `line-step2-dark.svg`.
Tall frames: the matching files under `../figure/tall/`.
Use the word "Jig" in the page serif for the mark.
The figure frames have their own background (light #f9f6f1 / dark #1a1713): make the surrounding
surface of that artboard match or deliberately frame it (a card/plate border), never leave a visible
mismatching rectangle. The figure may be cropped with overflow:hidden + object-fit/position, never distorted.
You may not add labels on the figure; captions go beside or under it.

## Hard rules
- Copy is verbatim from brief.md. Do not extend it, add claims, numbers or features. You may drop a secondary line
  where the layout has no place. Never write "software factory".
- Only the brief.md tokens; system font stacks; no external requests.
- Dark artboards use the dark token values (bg #1a1713, card #23201c, ink #ebe7e0, muted #b8b3ac,
  accent #82d2a8 ...). Check contrast of every text pair yourself.
- Do not render, screenshot or publish. The coordinator does that.

## Report (reply with)
The five paths; the typefaces used; every departure from the contract or the copy; anything you expect not to render as intended; one line on what the direction's motion moment would be at its settled state.
