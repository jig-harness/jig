# Dispatch dashboard — review scorecard

The review of the design rounds that landed in
[`dispatch-dashboard/`](dispatch-dashboard/README.md): round 2, the card
system (`export.html`), and round 2b, answering on the card
(`export-2b.html`), scored together against [the rubric](rubric.md), since
2b ships as part of round 2. Evidence names a scenario of
`dispatch-dashboard/design-handback.json` and a width, or a file in the
bundle.

Reviewed export base: 11abc0f661aebc39edda38ac804fcd55803eaab4

| Block | Result | Evidence |
|-------|--------|----------|
| First question | pass | `loud` at 320: the band's act counts (Decide 3, Authorize 1, Investigate 4) and the oldest wait with its pull request sit under the strip, and the first card's act and identity follow; at 390 the first card's ask is above the fold too. `quiet` at 320: "Nothing needs a person." in the same place. `answers-guard` at 320: the band counts the card, its decision and the pick held in this browser. Noted beside the row: at 320 the strip's tabs and the band's last chip scroll inside their own row, so the Needs you badge is off-screen there; the band carries the same answer. |
| Above the fold | pass | `loud-running` and `overload-running` at 1440: every gauge's fill, its line and the binding gauge end above 500px. `repos-queue` at 1440: the group, source and kind filters, the group-by switch and the first "starts next" card end above 900px. No scenario scrolls horizontally at any width. |
| Keyboard | pass | Every control is a native `button`, `select`, `input` or `a`, in document order, and `:focus-visible` draws the `--focus` ring (the `.dd` styles of `generated/dispatch-dashboard-round-2.html` and `generated/needs-you-round-2b.html`); each option row is a `button` with `role="radio"`. Noted beside the row: the round's handoff scores its own keyboard bar "partly" because the prototype simulates only some shortcuts (`j`, `k`, `o`, `Enter`, `g`, `/`, and 2b's picking keys); the shortcuts are 05's addition, not this block. |
| Contrast | pass | Every color is a token from the built page's set. The pairs round 2 adds are measured in `generated/round-2-handoff.html` (the Decide and Authorize pill 6.0:1 light, 9.31:1 dark; muted on `--hl` 6.34 and 5.0). The pairs 2b adds: ink on `--accent-soft` (a picked row) 13.96 and 10.87, muted on it 6.60 and 6.43, accent on it 6.04 and 7.49, `--wait` on the card 7.63 and 8.84, `--bad` on the card 7.17 and 8.16. Every family carries its container and icon besides its color, so greyscale keeps them apart (`loud-dark` and `answers-two-dark` at 1440). |
| Weight | pass | Drawn with React components, lucide-react 1.66.0 icons and native controls, all already in the built page's stack (`dashboard/`); neither round adds a library. Noted beside the row: the prototype pages render through the design tool's page runtime, inline in each generated page. |
| Truth | pass | Round 2 asks the server for nothing: every number, filter and grouping is derived from the line and the two additions being built (`links`, `tracker`), and the one optional ask, a linked issue's title, is listed in `generated/round-2-handoff.html`. Round 2b asks for nothing: picks, notes, drafts and the check live in the browser, stale and disputed come from the pull request, and nothing says "answered" (`generated/round-2b-handoff.html`). Round 2b's Needs you tab count is computed from its scenario's cards; its Merge, Running, Queue and History tab counts are fixed sample figures that do not follow the scenario. |
| Vocabulary | pass | One lucide icon per recorded word, its word beside it or in its accessible name, sets told apart by container; the full table is in `generated/round-2-handoff.html`, with 2b's added rows in `generated/round-2b-handoff.html`, and the Help view draws it from the same maps. Recorded words stay on the cards (`loud` at 1440: "Parked: waiting on a decision", the stage chip "rearm"). |
| Reshaping | pass | `quiet` and `loud` at 1440: with nothing to do the page is one line; with eight needs a filled band, facets and grouped cards take the page. `offline` at 390: a banner names the last read and its age with Retry, and the view says which read it shows and that it is not current. |
| Brand | pass | The built page's tokens, the serif headings, mono for ids and times, the Jig mark in the strip; no icon rail, no row of headline figures, no chart. |
| Decisions argued | pass | `generated/round-2-decisions.html` argues each of the brief's open decisions, §3.1 to §3.9, and the review of the page's top on a phone; `generated/round-2b-decisions.html` argues each of the addendum's, §4.1 to §4.9, and resolves each conflict with round 2. Each names the choice, what lost and why. |
| Neutral data | pass | Repositories `example-org/*`, accounts `work-a` … `codex-b`, people `maintainer-a` and `maintainer-b`, keys such as `API-77` and `#231`; no organization, person, account or real key in any bundle file. |
| Scenarios | pass | Round 2's Tweaks scenarios and round 2b's switch through `?scenario=`, with `?view=` and `?theme=`; each scenario of `design-handback.json` renders at 320, 390 and 1440, and the exports' sheets hold every scenario light and dark. |

Bar outcome: pass

Reviewed from the rendered pages at 320×568, 390×844 and 1440×900 in
Chromium on 2026-11-11. Not checked: Safari, on a phone or a desktop (the
rounds' own handoffs say they were tested in Chromium only), touch on a
real device, and the copy buttons' fallback over plain http beyond the
`offline` scenario's forced refusal.
