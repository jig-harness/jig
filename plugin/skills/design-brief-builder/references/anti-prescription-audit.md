# Anti-prescription audit

The mirror image of "argue your choice". A brief that frames the *problem*
produces design work; a brief that pre-bakes the *solution* produces
compliance theatre, and the designer rotates around your pre-baked answer
instead of producing new thinking, which costs a whole round and every token
it spends. This audit takes five minutes at most; run it before submitting
**every** brief.

## The four prescription smells

| Smell | What it looks like | Why it's wrong | Fix |
|---|---|---|---|
| **Named primitives** | "Use a `MetricBlock` + `TrendSparkline`" / "introduce a `SegmentedDonut`" | The brief is doing the abstraction work; the designer should discover the right primitives from the visual problem | Describe the design *problem* ("identify cross-widget shapes that recur; argue which earn promotion"). List only already-canonical binding primitives. |
| **"Best for X" assignments** | "Metric-first: best for conversion-rate, revenue, executive-summary" | Pre-assigns candidate patterns to specific surfaces, and that *is* the design work | List candidate patterns as non-exhaustive; ask the designer to assign and argue. |
| **Pre-baked taxonomy** | "I observe widgets A + B + C share a 'score + trend + breakdown' shape; draw them consistently" | The *discovery* of shared shapes is the design contribution | Ask the designer to identify the shapes; give the success bar (the canon's promotion threshold, if it states one; under- and over-abstraction both fail). |
| **Per-primitive visual recipes** | "Sparkline: single hue, `--chart-2` neutral, `--chart-3` positive" / "Donut: 4 segments max, legend below" | Token and status binding is correct; per-primitive visual recipes are downstream of the design | Separate binding (palette, status mapping, accessibility) from open (how a primitive uses them). |

Bias-the-answer hedges are subtler:

- "**Strong default**: auto-refresh per widget + no global controls." reads
  as the brief's answer; the designer rotates around it. Cut it.
- "**Either is defensible**; pick one." is too narrow if a third option
  exists. Phrase it as "candidate placements; argue your choice and consider
  others."

## The binding vs. open line

Keep on the **binding** side (prescribe freely):

- Design tokens (color variables, type scale, spacing).
- Status → token mapping (single source of truth).
- Production primitives that already exist and constrain the design.
- Already-canonical bundles (side panel, list-view chrome, any pattern an
  earlier bundle settled).
- Accessibility rules (status not by color alone, keyboard-first, a marker on
  AI-derived values).
- Voice, tone and banned-copy patterns ("no greeting copy", "no celebratory
  empty states").
- Reality grounding: schema, enums, existing routes, persona facts.

Keep on the **open** side (frame as a question, demand an argument):

- Visual treatments of new primitives (sparkline hue logic, donut segment
  count, heatmap drill-down).
- Page-level composition (grid logic, what sits beside what, severity
  escalation).
- Discovered cross-surface abstractions (which shapes recur, how they're
  named, where they're shared).
- Drill-down contracts (row preview vs. metric click vs. footer link).
- Time-range, refresh, role-switcher and chrome-inclusion questions.
- Empty, loading, error and partial-data state designs.

Drifting items from *open* to *binding* produces formalization. Drifting
*binding* to *open* produces drift from the design language. Both are
failures.

## The five-step gate (five minutes at most)

1. Re-read every "argue X" / "pick one" section. Does the brief immediately
   follow with the answer ("Strong default", "Best for", "I propose")? If yes,
   **cut the answer**.
2. Grep for smells:
   ```bash
   grep -riE 'best for|strong default|i propose|use a |introduce a ' /tmp/claude-design-trial-<slug>/uploads/*.md
   ```
3. List every named composite primitive in `01-component-inventory.md`. For
   each: "Is this binding because it already exists (canonical bundle or
   production code), or am I inventing it?" **Cut the inventions.**
4. List every visual-treatment recipe in `02-tokens-and-colors.md`. For each:
   "Token-level binding (palette, status mapping, accessibility), or a
   primitive-level visual choice?" **Cut the latter.**
5. For each numbered "open" section in `04-target-requirements.md`, count the
   prescriptive hedges. Zero is the target.

## Worked example: a dashboards brief, before → after

| Section | Before (prescriptive) | After (loosened) |
|---|---|---|
| `01` § composite primitives | Named 5 specific primitives (`MetricBlock`, `TrendSparkline`, `SegmentedDonut`, `AlertRow`, `MiniBarRow`) | Described the design problem ("identify shared shapes; argue promotion; under- and over-abstraction both fail") |
| `02` § color encoding | "Sparklines: single hue, `--chart-2` neutral, `--chart-3` positive…" plus 4 more recipes | Binding rules (tokens, status mapping, accessibility) listed; per-primitive recipes moved to "open: argue" |
| `04` §4.1 | 5 candidate hierarchies plus "Best for X" widget assignments | 5 candidate hierarchies as non-exhaustive; assignments asked of the designer |
| `04` §4.3 | "I observe widgets A + B + C share shape Y": taxonomy pre-baked | "Identify the cross-widget shapes; argue your taxonomy": asked of the designer |
| `04` §4.7 / §4.8 | "Strong default: auto-refresh" / "Either is defensible; pick one of these two" | Open questions reframed without bias; third options allowed |

## Creative-latitude patterns that work (the flip side)

- **"Argue your choice"** in every open section turns formalization into
  design work. It is the single highest-value pattern of the whole workflow.
- **"Two variants, two visual treatments"** forces a distinction the brief
  would otherwise flatten: for example, an AI marker that splits into
  "suggestion" (a full accept, correct or reject loop) and "extracted"
  (provenance only), rather than one flag in the markup.
- **"Make it survive the schema-drift test"** forces the information
  architecture to be grounded in real structure (a field such as
  `product.attributes`) rather than in invented groups.
- **Constraint as challenge**: pose a hard constraint as a design problem
  ("show that some rows are hidden by permissions without revealing what they
  contain") rather than as a spec. A challenge invites a designed answer where
  a spec produces compliance theatre.
