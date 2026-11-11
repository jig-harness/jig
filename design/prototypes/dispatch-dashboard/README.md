# Dispatch dashboard — design prototype

The Claude Design rounds for the dispatch dashboard, the page
`jig dispatch dashboard` serves. The briefs that produced them are kept
outside the repository; each round's decisions and handoff pages restate
its facts, its open decisions and what it asks of the server.

## Rounds

| Round | What it designed | Where it is |
|-------|------------------|-------------|
| 1: first design | The page's information architecture: one page in question order whose top half reshapes by state, the status vocabulary, the scenario sheets. | Superseded by round 2. Its export, pages and screenshots stay in this directory's history, at the parent of the commit that adds `export-2b.html`. |
| 2: the card system | The page as built today, redesigned card by card: one disclosure in a fixed left gutter, one identity for a pull request and an issue with linked work both ways, the product named instead of "tracker", group headings and facet chips, Running's load as gauge rows against their lines, What is coming grouped by what happens, and an icon for every recorded word. | `export.html` |
| 2b: answering on the card | An addendum to round 2 on Needs you: each decision of a park as a block of pickable option rows, answer states (the line's, for everyone; this browser's picks, notes and drafts), a check panel before copying a guarded pick, the copy row, and the keys that pick. It withdraws round 2's page-size limit: everything round 2 drew ships in one stage. | `export-2b.html` |

## What is here

| File | What it is |
|------|------------|
| `export.html` | Round 2's delivery as the design tool exported it, untouched: the dashboard at desktop size and in phone frames at 390 and 320, the work-identity primitive on its own, the decisions, the handoff, and the sheets of every scenario at 320, 390 and 1440, light and dark. Open it in a browser. |
| `export-2b.html` | Round 2b's delivery, untouched, with the same boards for Needs you. |
| `generated/` | The exports' pages, written by `tools/design/unpack-export.ts` and regenerated, never edited. `dispatch-dashboard-round-2.html` is the dashboard with its sample data and every view; `needs-you-round-2b.html` is Needs you as round 2b draws it; `work-identity.html` is the identity primitive; `round-2-decisions.html` and `round-2b-decisions.html` argue each open decision; `round-2-handoff.html` and `round-2b-handoff.html` give the icon vocabulary, the keys, the primitives, the server asks and the designer's own scoring of the bars. The phone frames and scenario sheets are generated too. Each page carries the components it imports and the design tool's page runtime inline, and a hook for the landing check that reads the page's props from the URL (`?scenario=`, `?view=`, `?theme=`, and `?switch=off` to hide the prototype's own switch) and marks the document ready once rendered. |
| `vendor/` | React 18.3.1 and its browser renderer, production builds (MIT, `vendor/LICENSE`), as the exports carry them, so the pages load nothing from the network. |
| `design-handback.json` | The scenarios the landing check renders at every configured width. |
| `screenshots/` | The delivered evidence, one image per scenario and width. |
| `handback-report.json` | The merge report of the round that landed. |

## Scenarios

Round 2, on `generated/dispatch-dashboard-round-2.html`: `loud`, `quiet`,
`empty`, `repos`, `volume`, `linked`, `unknown`, `overload` and `offline`,
the brief's Tweaks scenarios in its order (loud morning, quiet, empty,
many repositories with a long queue, Needs you at volume, linked work,
links unknown, load over its line, host unreachable), each on the view the
page opens with; `loud-running` and `overload-running`, the Running view
with its gauges; `repos-queue`, What is coming with its filters and
grouping; and `loud-dark`, the loud morning in the dark theme.

Round 2b, on `generated/needs-you-round-2b.html`: `answers-all`,
`answers-one`, `answers-one-picked`, `answers-two`, `answers-guard`,
`answers-dropped`, `answers-stale`, `answers-disputed` and
`answers-volume`, the addendum's scenarios, and `answers-two-dark`.

Any cell of the exports' sheets is the page at that width with
`?scenario=<id>&theme=<light|dark>`. The decisions and handoff pages are
drawn at a fixed 1200px width and are not scenarios.

## Review

The scorecard that reviewed rounds 2 and 2b is
`../dispatch-dashboard.scorecard.md`.

Bar outcome: pass

Export base: 11abc0f661aebc39edda38ac804fcd55803eaab4
Export base provenance: raw export
Previous export base: d892b94d549f53b4a5048a7d59da010e3371e5bf
Previous export base provenance: raw export
