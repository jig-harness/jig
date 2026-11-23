# Report: candidate A (`a-claude`, the bench)

Drawn by Claude from [contract A](../../briefs/contract-a-claude.md).

## Files

`vocabulary.md`, `description.md`, `build.mjs` (the scene), `engine.mjs` (the
isometric engine: solids with hatched faces, depth order, labels, no file
access), `wide/step-1..8.svg`, `tall/step-1..8.svg`, `agents.svg`, `item-states.svg`.

## Departures from the brief

- **Per-step cameras.** The whole plate fills a 16:9 frame to about 70 % of its
  width and leaves the item about 40 px wide, so steps 2 to 6 and 8 follow the
  action at a fixed zoom (the item at least 100 px wide); steps 1 and 7 show the
  whole line. The phone frame uses the same scene with the camera closer. The
  line, queue and desk are therefore not all in every still.
- **The item is drawn about 1.3 times larger than the machines.** A uniform
  scale about its own centre, so its marks read at plate scale.
- **The pose sheet** has no pose labels (the vocabulary has no such word); the
  poses run rest, reach, act from left to right. The follow-up and dispatcher
  rows show a stray belt piece because every row is drawn on a short belt.
- **One projection:** true isometric, 30 degrees, light from the upper left.

## What may not render as intended

- Depth order uses bounding boxes, so two overlapping solids (a gripper jaw that
  passes through a card, a platen resting on a sheet) can show a wrong overlap.
- The person is a bust built from prisms (plinth, torso, shoulders, neck, head);
  it reads as a figure at plate scale and as a stack of tiers when enlarged.
- Labels are placed by a simple collision search and dropped when no place is
  clear; a few stations are unlabelled in the zoomed steps.
