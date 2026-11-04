---
release: minor
---

The dispatch dashboard is split into views and explains itself in place.

### Added

- Views with tabs in the strip: Now (what needs you, what is running,
  what is coming), History (the window and the outcome log) and Help (what the
  page's words, stages and marks mean). The view is part of the address, so a
  link opens the same one. The Now tab shows how many items need a person.
- A theme switch in the strip: the device's theme, light or dark. The choice
  stays in the browser and in the link's `theme`.
- A reply box beside each parked decision. The draft stays in this browser
  only, and Copy answer takes `answer <key>: <reply>`, ready to paste as a
  comment on the pull request.
- Hints that open on hover, tap or keyboard focus: each stage chip (`rearm`,
  `pickup`, …), each queue source chip, each account's slot squares, the terms
  above the accounts, and a `?` beside every panel heading.

### Changed

- How old the data is is now one short line in the strip ("Updated 2 min
  ago"), turning into a warning when the timer is overdue or the server stops
  answering. Hovering or tapping it says which tick the page shows, when the
  next tick is due and when the page last read. The "as of the 16:45 tick" line
  on every panel is gone.
- "The line" panel is now called "What is running".
- A list showing its first two items (What needs you, What is coming) has its
  Show all / Show fewer button in the panel's heading too, so closing a long
  list needs no scroll to its end.
