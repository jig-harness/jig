# The introduction's line figure: second pass

The second drawing of the figure for the new introduction to Jig, issue
[#1066](https://github.com/jig-harness/jig/issues/1066). The first round chose
the page's layout (see [#1820](https://github.com/jig-harness/jig/pull/1820));
its figure was ruled out because it drew the line as a loop of boxes, left out
the pickup queue, showed the item as a plain box and named exact slot counts and
accounts for capacity. This pass draws the line again, as machinery.

This is a **design round**, not a build. It changes no site code and puts nothing
on a visitor page; a person accepts a design before the pages are built
([design/website.md](../../website.md)). What it delivers is candidates to pick
from, a stepped storyboard for each, and the record of how they were made.

## What the figure must show

Ophir's rulings of 2026-11-21 and 22, as the brief states them
([briefs/figure-brief.md](briefs/figure-brief.md)):

1. The line is not a loop. Follow up reaches Pick up as a short side feed.
2. The pickup queue is drawn.
3. The item changes form: an issue, the issue with a pull request, the pull
   request with review comments and build status, every check green, merged.
   It is never a plain box, and each form reads in greyscale.
4. The capacity wall shows how Jig takes capacity into account (memory,
   processor, disk, the forge budget, the usage limit) with no exact numbers and
   no mention of more than one account.
5. The stations are moving agents: arms, gantries, rovers, a press, a probe,
   each with a tool fitted to its job, drawn in three still poses (rest, reach,
   act). A person stays a person, shown where a question waits and where they
   merge.
6. The headline leads with the machinery, not with "software factory".

Motion is stepped: an agent moves when its station acts on the item, then
settles. There is no idle motion, and nothing here builds a joint animation
system.

## The storyboard

Every candidate has a still for each of eight steps, in a wide frame
(`960 x 540`) and a phone frame (`390 x 520`), light and dark by the site's
tokens alone.

| # | Step | What the frame shows |
|---|------|----------------------|
| 1 | Queue | Several issues wait; every agent is at rest |
| 2 | Pick up | The Pick up agent lifts the first issue onto the line |
| 3 | Build and open | The pull request appears; the Open agent acts |
| 4 | Drive | The Drive agent inspects; comments and build status; a question waits on the person's desk |
| 5 | Repair, then green | The Repair agent acts; every check is green |
| 6 | Merge | A person merges; the item is merged |
| 7 | Follow up | A new small issue rides the short side feed back to the queue |
| 8 | Capacity | The dispatcher reads the gauges; the usage limit is a wall and work waits in front of it |

Each candidate also has a pose sheet (`agents.svg`: each agent in rest, reach
and act) and a sheet of the item's five forms (`item-states.svg`).

## The candidates

The canvas page shows them under shuffled letters and holds the names back until
a pick is locked. **Read this table after picking.**

| Directory | Drawn by | Contract | Idea |
|-----------|----------|----------|------|
| [candidates/a-claude](candidates/a-claude/) | Claude (Sonnet 5.5) | [contract A](briefs/contract-a-claude.md) | **The bench.** Fixed stations on one straight belt: jointed arms, a C-frame press, a rail cart and a rover; the item travels. The camera follows the item through the middle steps. |
| [candidates/b-astra](candidates/b-astra/) | Astra (the model `gpt-6.2-astra`, through Codex) | [contract B](briefs/contract-b-astra.md) | **The rails.** The item sits on a long bench; the agents ride rails to it. |
| [candidates/c-gemini](candidates/c-gemini/) | Gemini 4 Neon (Antigravity) | [contract C](briefs/contract-c-gemini.md) | **The terraces.** The line climbs a stepped bench; instrument-maker's machines. |
| [candidates/d-astra-open](candidates/d-astra-open/) | Astra (the model `gpt-6.2-astra`, through Codex) | [open brief D](briefs/contract-d-open.md) | **Surprise me.** A strip of the whole line above a large view of the station that acts. |

Each directory holds the candidate's `vocabulary.md` (its proposal of the agent
for each station and of the item's five forms), `description.md` (written before
drawing: the objects and poses of every step), `build.mjs` (the one description
that writes every SVG), the SVGs, and `report.md` where the drawing model wrote
one.

## How the work was routed

- **Claude** wrote the shared brief, the four contracts, the checking tools, the
  viewer, candidate A and the review of every candidate
  (the design method's model routing).
- **Astra** drew B and D from their briefs, each in a fresh Codex session with
  its caches inside the workspace, then took bounded fix lists
  ([briefs/fix-pass-b.md](briefs/fix-pass-b.md) and the passes after it).
- **Gemini 4 Neon** drew C from its contract in one Antigravity session.
- Each family proposed its own agent vocabulary and item forms
  (`vocabulary.md`) before drawing. B and D, both Astra, arrived at the same
  item idea (a clipped-corner ticket); the other two families did not.

## What was checked

Layer 1, structure: `node tools/check.mjs candidates/<dir>` for every candidate.
It checks the viewBox, that colours are only the site's tokens as custom
properties, that text is only the brief's vocabulary with no digits, the text
size floor, unique ids and that every file parses. Layer 2, a look: contact
sheets in light and dark, in greyscale and at phone width
(`node tools/sheet.mjs`), read by the coordinator after each drawing pass. The
trial notes in [retrospective.md](retrospective.md) say what each look found.

A person signs off on the look. Nothing here is approved until Ophir picks.

## Facts the figure follows

The checkout was read at the time of the round. Capacity in the figure is only
what the repository reads today: host memory and processor load, disk, the forge
budget and a usage limit that takes an account out of every launch. Load
enforcement is configurable and off by default, so the gauges only inform and
only the wall stops work. A token budget as such is not a separate signal in the
checkout, so it is not drawn; the usage limit is the nearest. Tracker budgets
govern outbound calls separately and are not drawn as dispatcher gauges.

## Regenerate

From the repository root, with Node:

```sh
cd design/prototypes/intro-figure-pass-2
node candidates/a-claude/build.mjs      # likewise b-astra, c-gemini, d-astra-open
node tools/check.mjs candidates/a-claude
node tools/sheet.mjs candidates/a-claude out/            # contact sheets (needs Chrome: --chrome <path>)
node tools/build-viewer.mjs out/viewer.html              # the blind pick viewer
```

`tools/reveal.json` says who drew each directory; `tools/storyboard.json` holds
the step text the viewer shows. The viewer is a generated file of a few
megabytes and is not committed.

## What is open

- **The pick.** Ophir picks on the canvas page, in the blind viewer; the page
  records the pick and then reveals who drew what. The page's address is in the
  pull request description and in a comment on #1066.
- After the pick, a design round of variations on the winner, if there is one,
  then the build ([#1067](https://github.com/jig-harness/jig/issues/1067)).
- The headline and the copy of each page step stay as the first round left them
  except step 3, which the figure brief rewrites without numbers or accounts.
