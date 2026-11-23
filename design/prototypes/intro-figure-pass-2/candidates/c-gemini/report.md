# Report: candidate C (`c-gemini`, the terraces)

## Files delivered

- `vocabulary.md` — mechanical agent vocabulary and the five greyscale-legible item forms
- `description.md` — plate layout, camera framing, per-step scene descriptions, and motion notes
- `build.mjs` — zero-dependency Node script generating all 18 SVGs from one shared scene description (`STEPS`)
- `wide/step-1.svg` ... `wide/step-8.svg` — landscape storyboard (`960 x 540`)
- `tall/step-1.svg` ... `tall/step-8.svg` — recomposed portrait storyboard (`390 x 520`, text at least 14 units)
- `agents.svg` — pose sheet (`960 x 720`) showing all seven mechanical agents in `rest`, `reach`, and `act` poses plus the green `Merge` person at the summit desk
- `item-states.svg` — the item's five forms in a row (`960 x 240`)
- `report.md` — this report

All 18 SVGs pass `build.mjs`'s validator: self-contained, under 80 kilobytes (`17.9` to `78.1` kilobytes), strictly the ten permitted CSS custom-property colour tokens with light fallbacks, strictly the 20 verbatim vocabulary words, minimum text sizes (`12` wide / `14` tall), and zero label-to-label or viewport-edge overlaps.

## Departures from the brief

- **Cropped/zoomed framing in Steps 2–6 (per fix pass):** The base brief says the line, queue, side feed and person's desk are drawn in every still. Every still is generated from the single full scene, but per the fix pass Steps 2 through 6 crop and zoom the camera to the acting terrace and its immediate neighbours (letting the rest of the stair run off the frame edges) so the item reads at ~133–139 px wide in `wide` and ~98–101 px wide in `tall`, with all marks (registration ring, hinged open leaf, comment tabs, check sockets, signet seal) legible. Steps 1, 7 and 8 keep the full terraced block in frame.
- **No pose-name text in `agents.svg`:** The vocabulary rule forbids any word outside the 20-word list, so `agents.svg` orders each agent's `rest`, `reach`, and `act` poses left-to-right separated by engraved chevron paths rather than adding non-vocabulary labels. An eighth panel shows `Merge` (the person at the green summit desk in rest, waiting-question, and merging states) to contrast the person in green with the ink-and-paper mechanical agents.
- **Step 4 and Step 8 label subsets:** Labels are omitted where they would crowd the frame (e.g., off-screen stations in zoomed Steps 2–6, and idle mid-stair stations in Step 8 Capacity), as permitted by the brief.

## What may not render as intended

- **System-font pill width estimation:** Callout pill widths are computed from a character-count heuristic (`estimatePillWidth`) rather than live text measurement. Across different OS sans-serif stacks (`Segoe UI`, `SF Pro`, `Roboto`, `Helvetica Neue`, `Arial`), horizontal padding inside a pill (especially multi-word labels such as `Pull request`, `Forge budget`, and `Usage limit`) may look slightly tighter or looser than intended, though none are near clipping.
- **Tool-over-leaf overlap in zoomed Steps 3–5:** Because the active agent is drawn after the item so its tool contacts the work-plate from above, Open's presser bar (`step-3`), Drive's loupe and caliper arm (`step-4`), and Repair's staking turret punch (`step-5`) pass in front of part of the raised open folio-leaf. The leaf outline, drafted bars, comment tabs, and front check sockets remain visible around the tools, but the layering is slightly dense around the hinge spine.
- **Small items in overview Steps 1, 7 and 8:** Because Steps 1, 7 and 8 keep the entire terraced block in frame, the waiting Form 1 plates in the Queue tray, the small Form 1 issue sliding down the narrow chute in Step 7, and the resting Form 5 Merged plate on the exit pad in Step 7 are small—particularly in `tall` (`390 x 520`)—so their inner marks (registration ring, seal checkmark) read mostly as silhouettes in those overview frames.
- **Gauge callout leaders in `wide/step-8.svg`:** The four read-only dial gauges sit on the front-right apron and their labels sit below the plinth rim so they never cover the gauges, leaving slightly longer diagonal leaders (`~140–187 px`) on `wide/step-8.svg` than on Steps 2–7.
- **Dark-theme contrast on `--hl` surfaces:** The failed check socket (Form 3) and waiting Question card (Step 4) use `fill="var(--hl,#f7e8af)"` with `stroke="var(--ink,#251e18)"`. If a dark theme maps `--hl` to a pale or mid-tone highlight while mapping `--ink` to light text, the dark-on-light contrast of the `X` and `?` marks depends on the host theme choosing dark-mode `--hl` and `--ink` with sufficient contrast.

## Coordinator's note

The generator Gemini wrote was one file of about 2,600 lines. The repository
holds source files to 1,000 lines, so the coordinator split it along its own
section markers into `lib`, `item`, `agents`, `people`, `scene`, `sheets` and
`build` modules, moved `wrapSvg` into `lib` to remove an import cycle, and
confirmed that every one of the 18 SVGs is byte-identical before and after. The
drawing is Gemini's; the split changed no output.
