# Retrospective: the introduction's line figure, second pass

Written for needle-eye's log: copy it there as `2026-11-22-jig-intro-figure-pass-2.md`
and make the amendments it proposes in the skills it names, in that repository's
own pull request. It follows that repository's template. It also holds the notes
on the three trials the video-techniques retrospective left open: (a) one open
"surprise me" brief, (b) a render-and-look loop on every candidate, (c) the blind
side-by-side pick viewer, and on Gemini 4 Neon as a third model family.

- **Surface:** the second drawing of the introduction's line figure, issue
  [#1066](https://github.com/jig-harness/jig/issues/1066); the artefacts are in
  [README.md](README.md).
- **Date:** 2026-11-22 (the pick is Ophir's and was not made when this was written).
- **Written by:** the session that ran the round (Claude, Sonnet 5.5, in Claude
  Code). Ophir picks.
- **Skills used:** `needle-eye:model-routing`, `needle-eye:direction` (the
  contract and render rules; the round of variations did not run),
  `needle-eye:astra-drawing`, `needle-eye:one-description-many-renderers` and
  `needle-eye:checks`, version 0.1.0.

## What the method said, and what happened

| Skill and section | What it said | What happened | Evidence |
| --- | --- | --- | --- |
| model-routing, Who does what | Claude writes, Astra draws through Codex, a second family is the cheapest variety | Four candidates: one by Claude, two by Astra (one under a contract, one under an open brief), one by Gemini 4 Neon, which is a third family on trial | [README.md](README.md#the-candidates) |
| model-routing, Brief a worker | One brief file; paths and what to report; a worker does not judge its own result | Held for all three families. Each worker also wrote its own vocabulary and a scene description before drawing | [briefs/](briefs/) |
| astra-drawing, rubric | Grade against a reference, one or two changes per pass | There is no reference image for new content, so the checklist was the storyboard table. Fix lists were kept to two or three changes and each pass fixed what it named | [briefs/fix-pass-b.md](briefs/fix-pass-b.md), [briefs/fix-pass-d.md](briefs/fix-pass-d.md) |
| one-description-many-renderers | One description, both formats, a written description checked against the render | Every candidate has a `build.mjs` that writes the wide and the phone frames from one description, and a `description.md` written before drawing. The phone frame in A and C is the same scene with the camera closer | `candidates/*/build.mjs` |
| checks, Layer 1 | A gate that checks structure | `tools/check.mjs` (viewBox, token-only colours, a word list, no digits, size, ids, XML) passed every candidate; it caught one file over its size limit and nothing about looks | `tools/check.mjs` |
| checks, Layer 2 | Look at the output | Every candidate was rendered in light, dark, greyscale, wide and phone and read after each pass; see below for what each pass found | contact sheets from `tools/sheet.mjs` |
| direction, step 3 | The design tool renders four directions | Not used: the candidates are SVG generators, not artboards | none |

## What worked

- **A storyboard table in the brief.** Eight steps, each with what the frame must
  show, gave four candidates that could be compared step by step, and gave the
  coordinator a checklist to look against. Evidence:
  [briefs/figure-brief.md](briefs/figure-brief.md), and the viewer's stepper.
- **Writing the scene description before drawing.** The two Astra candidates and
  Gemini each wrote `description.md` first; the coordinator checked frames
  against it (for A, step 4's question card and step 5's removal of it).
- **A fix list of two or three located changes per pass.** Astra converged in
  three short passes (each about four minutes and 20,000 to 35,000 tokens):
  candidate B's first pass drew the item in an inset and the agents all alike;
  the second pass put the item on the bench and gave the bodies different forms;
  the third pass fixed one label collision. Evidence:
  [briefs/fix-pass-b.md](briefs/fix-pass-b.md), [briefs/fix-pass-b2.md](briefs/fix-pass-b2.md),
  [briefs/fix-pass-b3.md](briefs/fix-pass-b3.md).
- **Asking each family for its own vocabulary first.** The vocabularies differ:
  jointed arms and a press (A), crawlers on rails (B), a strip over a close view
  (D), a watchmaker's lathe, tweezers and loupe (C). B and D, both Astra,
  converged on one item idea (a clipped-corner ticket with a punched eye), so a
  second family does add variety and a second brief to the same family adds less.
- **A camera that follows the action** (A, and C after its fix pass). A 16:9
  isometric plate of a seven-station line fills about 70 % of the frame's width
  and leaves the item some 40 px wide; the item's morph, which is the point of the
  figure, could not be read until the camera moved in for steps 2 to 6.

## What did not work

- **The first drawing of each candidate hid the item.** B put it in an inset, D
  drew the capacity gauges as icons, A's whole-plate frames made it 40 px wide,
  and C's was about 30 px. In every case the figure's subject was the smallest
  thing in the frame, and only a look found it.
- **Gemini 4 Neon, through the Antigravity CLI.** Jig's plugin hooks load there
  and the turn-budget guard blocks every tool call (`the payload names no
  transcript_path`), so the CLI needs `JIG_TURN_BUDGET=0` in its environment
  before it can write a file. With the guard off the session drew a good first
  version and then kept editing for more than twenty minutes with no stop and no
  report, and its generator grew to about 2,400 lines; it was stopped and given a
  bounded fix list, as the others were. The brief had no stop rule.
- **The drawing models' own looks.** Astra's browser could not open a socket in
  its sandbox, so it looked at ImageMagick renders, not at a browser's; its note
  said so, which is why the coordinator rendered every file. A model's note about
  its own look told the coordinator what to distrust, not what was right.
- **The blind viewer cannot hide a model's habits.** The identities are held
  back, but a person who knows these families may guess from the drawing. This is
  not a defect to fix, only a limit of the practice.
- **The repository's own gates counted the generators.** The source-size ratchet
  (1,000 lines a file) and the dead-code check both run over `design/prototypes`.
  A's generator was 14 lines over, Gemini's 1,600 over; both were split into
  modules (Gemini's output byte-identical before and after), and the directory is
  ignored by the dead-code check as the first round's was. The brief did not say so.
- A `pkill -f <text>` in a command that itself contained the text killed the
  coordinator's own shell once. Match a process by its id.

## What the checks caught, and what they missed

- **Caught by the structural check:** one file over the size limit (A's capacity
  step, fixed by leaving out what lies wholly off the frame).
- **Caught by a look (the render-and-look loop):**
  - B: the item in an inset, one body for every agent, a label struck through by
    a gauge in the phone frame, "Usage limit" detached from the wall.
  - D: capacity drawn as tiny icons, a lower view that filled a third of the
    frame, a bracket drawn through a label, no path for the follow-up issue.
  - A: the item illegible at plate scale, a front-beam dispatcher that hid the
    line, a press whose front column hid the item, a person that read as a stack
    of tiers, a seal tick drawn the wrong way round, a pose sheet scaled
    separately in each cell so the poses could not be compared.
  - C: the item about 30 px wide in the first version, labels with long leaders
    crossing the stair, no report; its fix pass followed the camera and fixed both.
    Its generator was about 2,600 lines in one file.
- **Missed by every check:** whether the agents read as machines at a glance.
  That is for a person.

## Amendments made

None here. They go into needle-eye in its own pull request.

| Skill and section | Change | The practice behind it |
| --- | --- | --- |
| direction, Render one direction | Add: tell a worker that its generator files stay under the repository's source-size limit, and split before handing in |
| direction, Render one direction | Add: give every worker a stop rule (a number of look rounds, and "stop after the report") | Gemini's session, above |
| model-routing, Brief a worker | Add: a worker that runs on a host that loads Jig's plugin needs the turn-budget guard switched off for its process, or it cannot write | the Antigravity probe, above |
| checks, Layer 2 | Add: look at the figure's subject first. The first thing to measure on a frame is how large the item is | the four first drawings, above |
| one-description-many-renderers | Add: a long line in an isometric plate does not fill a 16:9 frame; give each step its own camera in the description | candidate A, above |

## Trial notes

### (a) One open "surprise me" brief among the contracts

Candidate D had no contract: the fixed list, the storyboard and the words, and
permission to choose everything else. Result: it differed from the contracted
candidates most in composition (a strip of the whole line over a large view of
the station that acts) and read best at a glance of the item. It did not differ
in the item's idea from candidate B, written by the same family under a contract.
The open brief earned its place in this round. Whether that is the brief or the
family is not answered by one round.

### (b) A render-and-look loop on every candidate before a person sees it

Run by the coordinator, not by the workers: render at 960 and 390 px in light,
dark and greyscale, list defects against the storyboard table, send two or three
located changes, render again. Passes: B three, D three, C two (one stopped, one
bounded), A about eight (the coordinator's own). Each pass found something the
last had not, and the first pass of every candidate found the item too small. The
loop cost the coordinator one image read per sheet; the contact sheets (two per
candidate per theme and format) made that affordable. It is worth keeping.
Whether three passes is enough was not tested.

### (c) The blind side-by-side pick viewer

Built as one page ([tools/viewer.template.html](tools/viewer.template.html),
[tools/build-viewer.mjs](tools/build-viewer.mjs)): candidates under shuffled
letters, one view, a side-by-side view of any two, the pose and item sheets, the
shared prompt, a shared stepper, wide or phone, light or dark; the pick is
locked before the page says who drew what, and is stored in the page's database.
Built in a few hours of the coordinator's time. Whether it reduces bias is for
Ophir's pick to say; this note is to be completed after it.

### Gemini 4 Neon as a third family

Strengths seen: the most distinct concept of the four (the line climbs a stepped
bench; instruments of a watchmaker), a first version that already followed the
style and the word list, a scene description that matched its drawing. Weak
points seen: no stop (above), tiny figures in the first version, the hook
problem on this host. Placement: concept exploration and composition, with a
stop rule in the brief. Not enough evidence for more.

## Candidates, not yet practice

- A `look` step in the brief: the first frame a worker draws is rendered by the
  coordinator before the worker draws the rest.
- A sheet of every frame at the size a visitor sees it, so the item's size is
  read without opening a file.
- Letting the pick viewer show the same step of every candidate in a grid.

## Open questions

- Does the pick favour the candidate with the largest item, whoever drew it?
- Is a second round of variations on the pick needed before the figure is built?
