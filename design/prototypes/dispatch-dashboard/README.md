# Dispatch dashboard — design prototype

The returned round of the Claude Design session for the dispatch
dashboard, the page `jig dispatch dashboard` serves. The brief that
produced it is kept outside the repository (its facts, data model and
open decisions are restated in the generated decisions and handoff pages).

## What is here

| File | What it is |
|------|------------|
| `export.html` | The delivery as the design tool exported it, untouched: the boards (the dashboard at desktop and phone size, the decisions, the handoff, and two sheets of every scenario above the fold). Open it in a browser. |
| `generated/` | The export's self-standing pages, written by `tools/design/unpack-export.ts` from `export.html` and regenerated, never edited: `dispatch-dashboard.html`, the dashboard itself with its sample data and status vocabulary; `decisions.html`, one argument per open question of the brief; `handoff.html`, the primitives proposed, the server ask the design makes and the bars. Each ends with the design tool's page runtime inline and, before it, a hook for the landing check that reads `?scenario=`, `?theme=` and `?switch=off` into the page's props and marks the document ready once rendered. |
| `vendor/` | React 18.3.1 and its browser renderer, production builds (MIT, `vendor/LICENSE`), as the export carries them, so the pages load nothing from the network. |
| `design-handback.json` | The scenarios the landing check renders at every configured width. |
| `screenshots/` | The delivered evidence, one image per scenario and width. |
| `handback-report.json` | The merge report of the round that landed. |

The scenario sheets of the export (every scenario at 390 and 1440,
light and dark) are the dashboard page at those sizes and parameters;
`generated/dispatch-dashboard.html` reproduces any cell with
`?scenario=<id>&theme=<light|dark>`.

## Scenarios

`quiet`, `loud`, `hung`, `queue`, `stopped`, `gone`, `token`, `empty`,
`long`, each the brief's Tweaks scenario of that name, and `loud-dark`, the
loud morning in the dark theme. The documents, `generated/decisions.html`
and `generated/handoff.html`, are drawn at a fixed 1200px width and are not
scenarios.

## Review

The scorecard that reviewed this round is `../dispatch-dashboard.scorecard.md`.

Bar outcome: pass

Export base: d892b94d549f53b4a5048a7d59da010e3371e5bf
Export base provenance: raw export
Previous export base: d892b94d549f53b4a5048a7d59da010e3371e5bf
Previous export base provenance: first-added fallback (no recorded raw export)
