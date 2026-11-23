# Figure brief: the line, second pass

Every candidate in this round is drawn from this brief. It fixes the story, the
files and the rules; the contract for each candidate says what is left open to
it. Issue [#1066](https://github.com/jig-harness/jig/issues/1066).

## What is being drawn

The introduction page of jig-harness.dev has one recurring figure: how one work
item travels through Jig's line of seven stations. The first drawing was a closed
loop of boxes and was ruled out. This pass draws the machinery itself: each
station is an agent, a mechanical agent with a tool fitted to its job, and the
item changes form as it goes. A person is a person, drawn where a question
waits for them and where they merge.

The page that will hold it is stepped, one figure state per step. This round
delivers still frames and a stepped storyboard to choose from. It is not a build.
Nothing goes onto visitor pages.

## Fixed

### The line

Seven stations, in this order: **Pick up, Build, Open, Drive, Repair, Merge,
Follow up.**

- The line is **not a loop.** Work enters at the queue and leaves at the merge.
  Follow up reaches Pick up as a **short side feed**, thin and mostly empty. It
  carries a small share of pickups. Draw no proportion and no count.
- **The pickup queue is drawn.** Items wait in front of Pick up. The dispatcher
  takes from the queue as capacity allows.
- **A person merges.** An agent never merges, never approves. The merge station
  is a person.
- **A person answers.** When only a person can settle something, the drive
  parks a question; it waits at the person.
- The stations (except Merge) are **moving agents**: robotic arms or other
  mechanical agents (a gantry, small rovers, a press, an inspection probe, a
  stamp, a lamp, a printer, whatever fits), each with a tool fitted to its
  station's job. Agents are machines. They have no faces and no human
  features.
- **No loop of any kind in the line, and no idle motion.** An agent moves when
  its station acts on the item, then settles. Each agent is drawn in **three
  separate still poses: rest, reach, act.** Do not build a joint animation
  system; the poses are stills.

### The item

The item's state is central. It is never a plain box. It takes these forms, in
this order, and **each must read in greyscale** (shape and mark, not hue):

1. an **issue**
2. the issue **with a pull request** (the pull request appears)
3. the pull request **with review comments and build status** (some checks
   pending, one failed)
4. the pull request with **every check green**
5. **merged**

The candidate chooses the form of each state (a card, a sheet with comment marks,
a sheet with check marks, a stamped sheet, a folder, a tray, a module...). The
forms must be a family: one can see it is the same item, changing.

### The storyboard

Eight stills per format. Each still is the settled frame at the moment the named
station acts: that agent is in its **act** pose and every other agent is at
**rest**. The line, the queue, the side feed and the person's desk are drawn in
every still.

| # | Name | What happens | What the frame must show |
|---|------|--------------|--------------------------|
| 1 | Queue | Work waits | Several issues in the queue in front of Pick up. Every agent at rest. Nothing on the line yet. |
| 2 | Pick up | An item is taken | The Pick up agent lifts the first issue out of the queue and onto the line. The issue form. |
| 3 | Build and open | The pull request appears | The Build agent has worked on it; the Open agent acts. Form 2: the issue with its pull request. |
| 4 | Drive | Review and checks | The Drive agent inspects the pull request. Form 3: comments and build status (pending marks, one failed mark). A question waits on the person's desk. |
| 5 | Repair, then green | Every check green | The Repair agent acts on the failed check; form 4: every check green. |
| 6 | Merge | A person merges | The person's moment: they merge. Form 5: merged. |
| 7 | Follow up | What the merge owes goes back | The Follow up agent sends a small new issue along the side feed to the queue's tail. The merged item rests at the end of the line. |
| 8 | Capacity | The dispatcher works within capacity | See below. |

Step 8 is the capacity wall. The dispatcher (an agent of its own, reading, not
launching) reads the host's capacity: **Memory, Processor, Disk** and the **Forge
budget** as read-only gauges, and the **Usage limit** as a wall. An item waits at
the wall: when an account reaches its usage limit, work waits outside until it
resets. Load enforcement is configurable and off by default, so the gauges only
inform and **only the wall stops work.** Draw gauges with no numerals, no tick
numbers and no counts. Draw one wall, never several; draw no account, no
subscription, no mention of more than one. Show that the queue is the thing that
waits.

### The words

Text in the drawing is only this vocabulary, verbatim, in the sans stack; add no
other word:

Queue, Pick up, Build, Open, Drive, Repair, Merge, Follow up, Dispatcher,
Question, Issue, Pull request, Comments, Checks, Merged, Memory, Processor,
Disk, Forge budget, Usage limit.

- Never the words "software factory". No numbers, counts or proportions in the
  drawing. No claim beyond what the table says. No logos, emoji, people's names
  or organisation names.
- A label may be dropped where it does not fit. No label may be cut off or
  overlap another.

### The style

Isometric engraving in jig-harness.dev's plate style: ink on warm paper,
hatching, one green accent, as in
[reference/round1-line.png](reference/round1-line.png) and
[reference/round1-wall.png](reference/round1-wall.png). Those frames are the
**style reference only**. Their content (a loop, boxes, slots, accounts) is
ruled out. Match their manner: fine ink outline, hatched faces for shade, flat
paper tones, a restrained green. You may draw in true isometric or in a close
paraline projection; one projection for the whole candidate.

- **Colour: only these tokens**, each used as a CSS custom property with the
  light value as fallback, `fill="var(--ink,#251e18)"`. No other colour literal,
  no gradients, no filters, no opacity-as-colour tricks beyond plain
  `opacity`.

  | Token | Light fallback | Use |
  |-------|----------------|-----|
  | `--bg` | `#f9f6f1` | paper |
  | `--card` | `#fffdfa` | pale faces |
  | `--sunk` | `#f0ece5` | recessed faces |
  | `--ink` | `#251e18` | outlines, hatching, text |
  | `--muted` | `#59514a` | quiet text and strokes |
  | `--line` | `#d5d0c8` | hairlines |
  | `--line-strong` | `#867f77` | mid strokes, shaded faces |
  | `--accent` | `#1a6444` | the one green |
  | `--accent-soft` | `#dbf2e4` | green face fill |
  | `--hl` | `#f7e8af` | highlight (use sparingly) |

- **Green is for two things only:** a person's moments (the person at the desk
  and the merge: a green solid with a figure on it) and the checks turning
  green (and the merged mark). Agents are ink, paper and grey, never green.
- No new web font. Text uses `font-family="system-ui, -apple-system, 'Segoe UI',
  Roboto, 'Helvetica Neue', Arial, sans-serif"`.
- Both light and dark themes work by the custom properties alone; do not draw
  anything that needs a fixed light background beyond `var(--bg)`.
- The drawing is for visitors who know pull requests, CI and trackers. Plain,
  not clever: a reader sees an agent at a station doing the job.

### Files and formats

Each candidate delivers, in its own directory `candidates/<id>/`:

| File | What |
|------|------|
| `vocabulary.md` | written **first**: the agent vocabulary and the item's five forms, at most 250 words |
| `description.md` | written **before drawing**: for each of the eight steps, the objects, their places on the plate, each agent's pose, the item's form and where it is, in plain sentences; plus one "motion note" per step saying what moves between this still and the next |
| `build.mjs` | a Node script with no dependencies (Node 26) that writes every SVG below from one description. One description, both formats. |
| `wide/step-1.svg` ... `wide/step-8.svg` | `viewBox="0 0 960 540"`, `width="960" height="540"` |
| `tall/step-1.svg` ... `tall/step-8.svg` | the phone layout, `viewBox="0 0 390 520"`, `width="390" height="520"`. It is the same scene recomposed for a portrait frame, not the wide frame shrunk. Text is at least 14 units. |
| `agents.svg` | the pose sheet, `viewBox="0 0 960 720"`: each agent in its three poses (rest, reach, act) side by side, labelled by station |
| `item-states.svg` | the item's five forms in a row, `viewBox="0 0 960 240"` |
| `report.md` | paths, every departure from this brief, and what you expect not to render as intended |

SVG rules: self-contained (no `<image>`, no external references, no script, no
`<style>` with `@import`, no animation); ids unique within the file; at most
80 kilobytes a file; wide text at least 11 units, tall text at least 14 units; nothing
clipped at the frame.

### Process rules

- Write `vocabulary.md`, then `description.md`, then `build.mjs`. Do not open any
  other candidate's directory.
- You may render your own output with a browser to debug it. Your own look is not
  evidence; the coordinator renders and checks every file.
- Do not publish, commit or push anything. Do not write outside your candidate
  directory.
- Put no local paths, account names or secrets in any file.

## Rubric the coordinator uses

For each step the frame must show what the storyboard table says (an item list
the coordinator ticks), read in greyscale, and hold at 960 and 390 wide. The five
criteria of the Astra rubric (composition, identity and contact, colour regions,
volume and edges, selective detail) are scored 0 to 3 on each candidate's frames
for steps 4 and 8, the two hardest. A person picks.
