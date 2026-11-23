# Round brief: Jig's introduction page and the site's new look (issue #1066)

One round covers two things (D8): the overhaul of the jig-harness.dev look and a new
introduction to Jig. The introduction is one stepped page on the site (D10); the same
scenes will later give a talk deck and a short video. The build is a later issue (#1067);
this round only fixes the look, in pictures.

## Who reads it
An engineer or lead whose team already uses AI coding agents; ten minutes; knows pull
requests, CI and trackers; knows none of Jig's words. Plain voice: present tense,
named actors, short absolute boundaries, no selling adjectives, no sentence over 30 words.

## Fixed (do not reopen)
- **Do NOT use the phrase "software factory" anywhere** in headline, copy or captions.
  (Ophir: it is an overhyped buzzword.) Lead with Jig's concrete machinery instead.
- **A person merges.** Never imply an agent merges, or that every item finishes.
- **Palette: only these tokens** (each is light/dark): bg #f9f6f1/#1a1713, card #fffdfa/#23201c,
  sunk #f0ece5/#13100d, ink #251e18/#ebe7e0, muted #59514a/#b8b3ac, line #d5d0c8/#433f3a,
  line-strong #867f77/#847f78, accent (green) #1a6444/#82d2a8, accent-soft #dbf2e4/#1b3427,
  hl #f7e8af/#4e3e09, hl-line #815b1f/#ddc276, focus #0267c7/#7dbaff. Warm paper, ink, one green.
  No new hue. Both themes are designed.
- **Type:** no web fonts. System stacks only: serif (Iowan Old Style, Palatino, Georgia),
  sans (system-ui), mono (ui-monospace). Headings are serif today.
- **Figure style:** the intro's figures are isometric engravings in the site's plate
  style: ink on warm paper, hatching, the green accent. They are drawn as motion-kit `SVG`
  scenes using the isometric helpers available to built pages. The jig model's hatching shader is
  their 3D counterpart. The figure is shared across all directions; directions differ in
  how the page uses it (placement, scale, framing, caption, stepping), not in its drawing.
- **Status:** shipped vs planned must survive greyscale (shape/line style/words, not hue).
  The dispatcher's unattended operation is planned until live-host checks are recorded:
  machinery ships, the claim that the line runs by itself unattended is labelled planned.
- No stock photography, invented statistics, customer names or logos, emoji, decorative
  gradients, feature grids, icon rows, "trusted by" strips, glassmorphism.
- Every page reads without JavaScript; motion respects reduced motion; widths 320, 390, 1440.
- Logo: `../canvas/logo.svg`. The engraving-manner plates the original session used are not
  part of this archived round; the canvas files show the manner as drawn.

## The page: copy (verbatim; direction workers may drop a secondary line, never extend)
Opening
- Headline: "A work item goes in. A pull request you can merge, or a question for you, comes out."
- Sentence: "Give an agent a work item; it builds the change, runs the checks and works through review until the pull request is ready or needs your decision. You merge."
- Link: "Start with an audit"

Five steps (the page is stepped through these, in this order)
1. Label "The line". Title "Seven stations, run as a loop."
   Body "Every change passes the same stations: pick up, build, open, drive, repair, merge, follow up. A person merges at the sixth. The follow-up sends what the merge owes back to the first."
2. Label "The tick". Title "A timer wakes the dispatcher."
   Body "Every few minutes the dispatcher reads the tracker, the pull requests and the running sessions. Then it starts what should be running and is not."
   Status mark: "Machinery ships. Running unattended is planned."
3. Label "The slots". Title "Two slots per account, and the wall."
   Body "Each subscription account holds two sessions at once. When an account reaches its usage limit, that is the wall: the account stays out of every launch until the wall resets."
   (This is the copy the round rendered. A later draft replaces it; see "Step 3 after the round" below.)
4. Label "The ledger". Title "The drive keeps its ledger on the pull request."
   Body "One comment records the round, the last head checked and every parked question. Another machine reads it and picks up where the drive stopped."
5. Label "The question". Title "A question waits until you answer."
   Body "When only a person can settle something, the drive stops and parks a question with its options. You answer on the pull request or on the dashboard's page. The next tick re-arms the drive."
Close: "You merge." then link "Start with an audit".

## The three artboards every direction delivers
A. **Hero**: the opening above, with the figure's place. At 1440x900 and 390x844 (light + dark).
B. **One step**: step 3 ("Two slots per account, and the wall") in the page, at 1440x900 and 390x844,
   showing how the stepped page reads, where the step number/progress sits, how a step differs
   from its neighbours, and the figure in that step's state.
C. **One frame of the recurring figure**: the isometric engraving of the line, as that direction
   frames it (crop, scale, caption, labels). The figure source is in `../figure/`.

## What differs between directions (the open decisions)
Layout idea of the stepped page (sticky figure vs. scrolling plates vs. full-bleed chapters vs.
a rail/index vs. ...), type scale and heading character, shape language (rules, key caps,
frames), how the five steps are numbered and shown as steps, how "a person's moment" (merge,
answer) differs from the agents' steps, how planned is marked, the one motion moment.

## Step 3 after the round (draft, not rendered)
The round was rendered with the step 3 copy above. After the round the copy was ruled out for
naming exact numbers and several accounts, and a draft replaces it. The draft is not approved
and has no artboard; [../figure-brief.md](../figure-brief.md) holds the rules the next session
writes against.
- Label "Capacity". Title "The dispatcher works within capacity."
  Body "The dispatcher respects usage limits. It can also consider processor load, free memory, disk space and the forge budget; load enforcement is configurable and off by default."
