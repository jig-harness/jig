# Direction contracts C1-C4 (Claude)

Typeface licences, common to all four: nothing is served. Every face is licensed to the reader's operating system. Serif stack: Iowan Old Style (Apple, bundled with macOS and iOS), Palatino Linotype (Linotype, bundled with Windows and macOS), Georgia (Microsoft, bundled with Windows and macOS), then the OS serif (DejaVu Serif or Noto Serif under free licences on Linux). Sans: system-ui, which is San Francisco on Apple, Segoe UI on Windows, and Roboto (Apache 2.0) or Cantarell (`OFL`) on Linux. Mono: ui-monospace, `SF` Mono, Menlo, Cascadia Mono (`OFL`), Consolas, then DejaVu Sans Mono.

---

## C1 Timetable

*Reference world: railway timetables and signal-box track diagrams. Constraint: one column only, with no sidebar and no cards.*

1. **Name:** Timetable.
2. **Idea:** One track runs down the column, and each step is a station the reader passes in order.
3. **Typefaces:** mono carries numerals, labels and station names. Serif carries titles and body. No sans except the site nav.
4. **Scale:** ratio 1.25. Headline 44/52 serif regular, step titles 28 serif regular, labels 14 mono capitals tracked +0.06em, tabular numerals throughout. Headings read as timetable entries, not announcements.
5. **Stepped page:** a single 680px column. A 2px track runs down the column's left edge, inside the column, with text indented 48px. Steps 01–05 are stations on it. The figure enters between the opening and step 1, then recurs inside each station, cropped to that step's state. At 390 the track sits in the 16px gutter and the indent drops to 32px.
6. **Shape:** hairlines only. A dotted leader runs from number to label, as in a timetable row: "03 ······ The slots". Each station is a 14px ring on the track. No frames and no boxes.
7. **Colour:** text in ink on bg, labels in muted. The track is line-strong. Accent marks the track already passed and the person's stops.
8. **Imagery:** the figure is printed bare on bg at full column width as a 4:1 band. Its caption is one mono row naming the seven stations, each aligned under its station like a timetable header.
9. **Devices:** the number is "03" in mono, sitting on the track. A planned stretch is a dashed track with an open ring and the word "planned", like a railway map's line under construction. A person's moment is a solid square station (the logo's square) with "You" beside it; agent stations are rings. The green travelled line stops at that square.
10. **Motion:** scroll-driven CSS (animation-timeline, no JavaScript). The green line extends to each station as it reaches mid-viewport. Under reduced motion, or where the browser lacks support, the track is plain line-strong and every station is still marked.
11. **Fit:** a timetable states the order, the stops and who acts at each one. That is the page's whole claim, read top to bottom in ten minutes.
12. **Risk:** at 1440 the single column leaves wide margins and can read like a docs page. If the stations are faint, the track reads as ornament.

---

## C2 Plates

*Reference world: 18th-century encyclopedia plates. Constraint: the figure always spans the full text column, and text never overlaps it.*

1. **Name:** Plates.
2. **Idea:** each step is a numbered plate: the engraving across the column, then a keyed legend that names its parts.
3. **Typefaces:** serif only for all page text. system-ui appears only in the site nav. No mono.
4. **Scale:** ratio 1.2, centred and symmetric. Headline 40 serif regular, step titles 26 serif italic, plate heads 14 roman capitals tracked +0.18em. The headings are quiet.
5. **Stepped page:** the plates scroll in a centred 760px column, one plate per step. Each plate runs, top to bottom: plate head ("Plate `III` · The slots"), the figure at full column width, a key strip, a two-column legend, then title and body. A thin rule and generous space separate the plates. The opening carries the whole line as a frontispiece.
6. **Shape:** each plate has a neat-line frame: a hairline inside a line-strong rule. The plate number sits top right in the frame, in roman numerals I–V. No key caps.
7. **Colour:** plates sit on card inside a bg page, nearly monochrome ink. Accent goes only to the current step's key letter and to links.
8. **Imagery:** the figure always spans the column. Its crop changes per plate (the whole line for step 1; for step 3, the two slots and the wall). The key strip sits below the figure: letters on a hairline, each with a short tick up to its part. No text touches the figure.
9. **Devices:** the number is "Plate `III` of V". A planned item is set in the legend in italic, with "[planned]" in brackets and a dotted underline. Agent parts are keyed with italic lowercase letters. A person's moment is keyed with a boxed roman capital (M for merge, Q for the question), and its legend entry begins "You".
10. **Motion:** on first load, the frontispiece's line work draws in left to right over 1.2s, like a burin cutting the plate. Under reduced motion the plate appears finished.
11. **Fit:** the evaluator learns Jig's parts by name. A keyed plate shows and names each part without asking for trust.
12. **Risk:** the page can read antique and slow. Matching letters to the legend moves the eye back and forth, and at 390 the legend can feel like homework.

---

## C3 Strip board

*Reference world: an operations room, with paper flight strips on rails and shift logs. Constraint: at desktop width the steps run horizontally.*

1. **Name:** Strip board.
2. **Idea:** the five steps are paper strips held in a rail, read left to right like a controller's board.
3. **Typefaces:** system-ui carries the headline, titles and body. Mono, in capitals, carries field labels and log lines. No serif on this page.
4. **Scale:** compact, ratio 1.2. Headline 40 sans 600 with −0.01em tracking, strip titles 20 sans 600, body 16, field labels 14 mono capitals.
5. **Stepped page:** the opening sits above a full-bleed figure window, with the board below. At 1440 the board is a horizontal scroll-snap row of five 560px bays. The bay in view is centred and its neighbours show at the edges in muted. A five-slot rail above the board shows the position. Previous/next are anchor links (#step-3) and the row scrolls by keyboard, so it works without JavaScript. At 390 the strips stack vertically.
6. **Shape:** each strip is a long square-cornered rectangle with a 1px line border. Vertical rules divide it into number cell | label and title | body | status cell. The rail is a sunk channel with line-strong lips.
7. **Colour:** the board is sunk, the strips are card, the text is ink. Accent fills the rail slot of the bay in view. hl fills the person's number cell.
8. **Imagery:** the figure sits in a 300px-high window at a fixed scale. Mono station tags label it in a band below the window, never on it.
9. **Devices:** the number is "03" in large mono in the strip's left cell. A planned strip has a status cell with a cross-hatched block and "planned", and the strip sits cocked 8px out of the rail, the way a controller marks a strip to watch. The status line prints as that strip's log line. A person's moment has a 4px left edge and an hl number cell; agent strips are plain.
10. **Motion:** as the board scrolls, the figure window pans along the line to the stations of the bay in view (CSS scroll-timeline). Under reduced motion the window shows the whole line, still.
11. **Fit:** evaluators already read pipelines and boards left to right. The page feels like a tool they operate, not a brochure.
12. **Risk:** horizontal scrolling is hard to discover and awkward with a mouse wheel. At 1440x900 the opening, window and board compete for height. It invites "where is the live data?"

---

## C4 Broadside

*Reference world: tool-maker catalogues and letterpress broadsides. Constraint: serif only, with no sans-serif anywhere except the 14px minimum UI labels.*

1. **Name:** Broadside.
2. **Idea:** the page is set like a printed tool catalogue: big serif lines and numbered entries, each with its cut beside it.
3. **Typefaces:** serif only, in bold, roman and italic, with old-style numerals (Iowan and Palatino carry them, and Georgia's default figures are old-style). system-ui appears only in the 14px nav and skip link. No mono anywhere.
4. **Scale:** poster contrast, ratio 1.5. Headline 72 bold on 1.02 leading, with its sentences in falling sizes (38 at 390). Step titles 40 bold, labels 18 italic, body 19.
5. **Stepped page:** catalogue entries alternate sides down the page. The cut takes about 55% of the width and the entry the rest. Thick-thin rules span the measure between entries. At 390 each cut sits above its entry.
6. **Shape:** thick-thin brass rules (2px, a gap, 0.5px). Key caps mark a person's moments: a rounded rectangle with a heavier bottom edge, set in serif small capitals. The cuts have no frames.
7. **Colour:** ink dominates. Accent is used for the key caps' borders and for links. The key caps' face is accent-soft.
8. **Imagery:** the cut sits on bare bg, scaled large enough to bleed to the viewport edge on its side at 1440. Below it is an italic caption carrying the step label.
9. **Devices:** the number is "No. 3" as a large old-style serif numeral. Planned is marked with a dagger (†) after the step title and a footnote under the entry: "† Machinery ships. Running unattended is planned." A person's moment is a key cap: "Merge" in step 1, "Answer" in step 5, and the closing "You merge.". Agent steps carry none.
10. **Motion:** the closing "You merge." prints as it enters view, going from a blind impression in line colour to full ink in 240ms. Under reduced motion it is inked from the start.
11. **Fit:** it reads like a supplier's catalogue the evaluator would trust: each part numbered and shown, and what is still on order marked plainly.
12. **Risk:** bold display serif can read nostalgic or loud against the plain voice, and Georgia's fallback is heavy. Short bodies beside large cuts can make the entries look thin.

---

## Comparison

| | Type treatment | Layout of the stepped page | Motion moment |
|---|---|---|---|
| C1 Timetable | Mono numerals and labels; serif regular titles at a modest scale | One column on a vertical track; steps are stations; figure recurs inline | Green travelled line extends down the track on scroll |
| C2 Plates | Centred serif: spaced roman capitals, italic titles, keyed italic letters | Scrolling framed plates; figure full column width, key strip and legend below | Frontispiece line work draws in once on load |
| C3 Strip board | Sans throughout; mono capitals for fields and log lines | Horizontal scroll-snap board of five strips under a full-bleed figure window | Figure window pans along the line with the board |
| C4 Broadside | Serif display at poster contrast, bold, old-style numerals | Alternating catalogue entries: cut on one side, entry on the other | Closing "You merge." prints from blind impression to ink |
