# Dispatch dashboard — review scorecard

The review of the design round that landed in
[`dispatch-dashboard/`](dispatch-dashboard/README.md), scored against
[the rubric](rubric.md). Evidence names a scenario of
`dispatch-dashboard/design-handback.json` and a width, or a file in the
bundle.

Reviewed export base: d892b94d549f53b4a5048a7d59da010e3371e5bf

| Block | Result | Evidence |
|-------|--------|----------|
| First question | pass | `loud` at 390: the band "8 need a person", the oldest wait and the first target are the first thing under the strip; `quiet` at 390: "Nothing needs a person" in the same place. |
| Above the fold | pass | `loud` at 1440: What needs you, The line with its accounts, What is coming and the Window's class counts all end above 900px with no horizontal scroll. Scored under the rubric's scope for this block: in `gone` the counts stay on the page, disabled, below the fold (about 1010px) behind the banner that says the server is gone, and the banner is the content there. The handoff's "Not met in 6a" is the same fact. |
| Keyboard | pass | Every control is a native `select`, `input`, `button`, `details` or `a`; `:focus-visible` draws the `--focus` ring (`generated/dispatch-dashboard.html`, the `.dd` styles). |
| Contrast | pass | Every text color is a token pair from the website's set, which meets AA in both themes; the two added status tokens (`--bad`, `--wait`) are the site's own code hues, with the ratios in `handoff.html`. Each role carries a glyph in its key cap, so greyscale keeps them apart (`loud-dark` at 1440). |
| Weight | pass | Disclosures are native `details`, filters native controls, layout grid and container queries, themes `light-dark()`, marks text and CSS, the logo drawn inline as vector graphics; the proposed production design needs no run-time library (`generated/decisions.html` § 3.12). Noted beside the row: the prototype pages as exported render through the design tool's page runtime (`x-dc` templates in `generated/dispatch-dashboard.html`), and the page as built runs on React, TanStack and Base UI by the maintainers' choice, so this bar holds for the design and not for the built page (`../dark-factory-dispatch.md` § The dashboard). |
| Truth | pass | "Added by hand: not available" is a dashed cap with a sentence, never a control (`queue` at 1440); the strip shows the plugin version; no cost or token figure anywhere; every count on the page is computed from the scenario's rows (`generated/dispatch-dashboard.html`, its `data.jsx` section). Noted beside the row: the capabilities the backend lacks today (live reads, sessions, needs, queue, recurrence) are the server asks listed in `generated/handoff.html`, implementation deferred. |
| Vocabulary | pass | Each role is a key cap with a glyph beside the recorded word; the Legend at the page's foot is built from the mapping in the `status.jsx` section; class names appear unchanged in the log rows (`quiet` at 1440). |
| Reshaping | pass | `quiet` and `loud` at 1440: with nothing to do, the answer is one line and the log takes the wide column; with eight things wrong, a filled band appears and What needs you takes the wide column. |
| Brand | pass | The website's tokens, the serif headings, the mono for ids and times, the Jig mark in the strip; no rail of icons, no row of headline figures, no chart. |
| Decisions argued | pass | `generated/decisions.html`: one argument per open question of the brief, each naming the choice, the alternatives and why they lost. |
| Neutral data | pass | Repositories `example-org/*`, accounts `work-a` … `codex-b`, items `WEB-412`, `API-77`, `#231`; no organization, person, account or real key in any bundle file. |
| Scenarios | pass | Every scenario and the dark variant render at 390 and 1440 through `?scenario=`, `?theme=`; `screenshots/` holds one image per scenario and width. |

Bar outcome: pass

Reviewed from the rendered pages at 390×844 and 1440×900 in Chromium on
2026-11-03. Not checked: a phone browser other than Chromium, and the copy
buttons' fallback over plain http.
