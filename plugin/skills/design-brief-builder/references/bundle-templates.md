# Bundle templates

Copy-paste scaffolds for the `uploads/` bundle. Replace every `<…>` and `[…]`
placeholder. Keep everything Markdown: the upload interface rejects
`.yaml`/`.yml`/`.json`/spreadsheets.

Target directory: `/tmp/design-brief-<flow-slug>/uploads/`.

`<kit>`, `<design-language>` and `<prototypes>` below are the repository's
design kit, design-language document and prototypes directory, as
`<skill-dir>/SKILL.md` § Consumer configuration resolves them. Where the
repository has no kit, take the same material from the design language and
the component library, and say so in the file.

The bundle is the external session's only input: it cannot read the
repository. Every source a file binds the design to or cites goes into the
bundle as a readable copy under `reference-specs/`, and every citation points
at that copy. In the scaffolds, `[cite <design-language> § X]` means: cite
section X in the design-language copy under `reference-specs/`.

## Choosing full vs. creative

- **Full brief**: six files `00`–`05`. Use when the screen has a settled data
  shape you want Claude Design to render faithfully.
- **Creative brief**: four files (`00` folded into `01`; slot `03` **left
  empty**). Use when the information architecture itself is in question and
  you want `04`'s "argue your layout" prompts to drive discovery. A structured
  `03` spec fights those prompts, so omit it.

---

## `00-design-system-brief.md` (full brief only)

```markdown
# <Product> — design system brief

Copy voice/tone/non-negotiables verbatim from `<kit>/README.md`.
Do not paraphrase — the kit README is the source of truth.
[No kit: copy them verbatim from <design-language> instead, cite the sections,
and state here that the repository has no design kit.]
[Neither a kit nor <design-language>: do not write voice or rules yourself.
State that the repository has no voice or policy guidance, list that gap in
`04`, and give only what the component library shows.]

## Voice & tone
[paste from kit README, or from <design-language> § copy without a kit; with neither, "No voice guidance in this repository (see 04)."]

## Non-negotiables
[paste the kit's numbered non-negotiables, or the rules <design-language> states as binding without a kit; with neither, only conventions the component library enforces in code, each cited, and "No written policy (see 04)."]
```

## `01-component-inventory.md`

```markdown
# Component inventory — <flow>

## Binding primitives (reuse these; do NOT invent new named primitives here)
List ONLY primitives that already exist in the kit (no kit: the component library) or a prior <prototypes>/* bundle.
[No kit: say so here, and name the component library each primitive comes from.]
- `<PrimitiveName>` — <one line: what it is, where it's canonical>
- e.g. `StatusBadge`, `ConfirmDialog`, `DataTable`, side panel

## Explanatory affordances (ALWAYS list these — every surface needs the ruling)
List the design language's canonical help and explanation primitives, each with its trigger, size and usage rule exactly as the canon states them, and cite the section. [Derive the set and every rule from <design-language>; do not supply rules it lacks. For example, a canon might define a click-opened help popover, a link to a help article with the places it may appear, a hover preview of a referenced entity, icons reserved for help and for notices, and what a tooltip may carry.]
- <affordance> — <trigger, size, usage rule, as the canon states it>. [cite <design-language> § help]

## Help placement to answer in this brief (name the sites, do NOT design the affordance)
- Which labels on this surface a first-time <persona> would not understand — and whether a better *label* fixes each one before an affordance is proposed.
- Any computed number ("how is this calculated"), state vocabulary (placed where the canon puts its legend), or AI confidence band on the surface.
- Whether a page-level help-article link is warranted at all (apply the design language's "warrants an affordance" test first, if it has one) — answer **none** if it fails the test or no authored article exists yet; never invent a route or add help the canon says to omit. If warranted, name the specific article and verify it exists in the repository's help content before citing it.
- [cite <design-language>'s help-placement rules and its "when not to add one" rule]

## Anti-invent rules
- Assemble from binding primitives; propose a NEW primitive only with an argued justification.
- [The canon's threshold for promoting a shared shape to a primitive, if it states one, e.g. "≥ 3 surfaces share it".] Under- and over-abstraction both fail.

## Icon / layout / typography rules
- Icons: <icon set>, <sizes>, [the canon's other icon rules, e.g. whether emoji are allowed]. Body text <size>. [cite <design-language> § icons, § typography]
- Layout / density: [cite <design-language> § layout]
```

## `02-tokens-and-colors.md`

```markdown
# Tokens & colors — <flow>

## Tokens (pointer — do not redefine)
Use the color and type tokens listed in `reference-specs/tokens.md`. [Export `<kit>/<tokens stylesheet>` to that file as Markdown (token name, value, intended use) and include it in the bundle. No kit: export the stylesheet or theme file the component library takes its tokens from instead, and name it in the file.]

## Status enum → token mapping (single source of truth)

| Status | Token | Meaning |
|--------|-------|---------|
| <status> | `--<token>` | <meaning> |

## Accessibility (binding)
- Status never by color alone — pair with icon/label.
- AI-derived values carry an AI marker.
- Keyboard-first; visible focus.

## Open (argue in the session, do NOT prescribe here)
- Per-primitive visual treatment (sparkline hue logic, donut segment count, mini-bar fill) — leave to the designer.
```

## `03-target-<flow>.md` (full brief only: entity facts, never structure or layout)

```markdown
# <Entity> — data shape

## Entity fields

| Field | Type | Notes |
|-------|------|-------|
| <field> | <type> | <cite the schema excerpt in reference-specs/> |

## Related data (links, suggestions, provenance, audit)
[headings + tables — the DATA, not how to lay it out]

## Glance questions the user must answer at a glance
[bullets — problem framing, not layout answers]
```

## `04-target-requirements.md` (the creative ask)

```markdown
# <Flow> — requirements

## §1 Persona & scope
[who uses this, density expectation, primary job]

## §2 Hard constraints (binding)
[must / won't — real constraints only, not design answers]

## §3 Open design decisions — ARGUE EACH
Frame the PROBLEM, then demand an argued choice. No "strong default", no "best for X".
- §3.1 Page structure — the old spec prescribes <X>. **Challenge this. Pick one and argue why.**
- §3.2 Status at a glance — show how two contrasting states reshape the overview. Don't just swap a badge color.
- §3.3 <cross-surface shapes> — identify shapes that recur; argue which earn promotion to a primitive.
- §3.x <other open questions> — list candidate placements as non-exhaustive; argue your choice, consider others.

## §4 Anti-patterns
- [The canon's banned copy and chrome patterns, e.g. no greeting copy.] No generic web-app template chrome. [cite <design-language> § copy]

## §5 Deliverables
- index.html + component tree + data.jsx (Tweaks ≥ 3 states) + status.jsx if status is involved.
```

## `05-success-criteria.md`

```markdown
# <Flow> — success criteria

## Quantitative bars
- Above-fold density: <target>. Viewport target: <e.g. 1440×900>. Keyboard coverage: <target>.

## Qualitative bars
- Recognizable as <Product>, not a generic web-app template.
- The information architecture reshapes per state where meaningful, not just chrome changes.

## Tweaks scenarios (≥ 3 meaningful states)
- <state 1>, <state 2>, <state 3>, [edge/empty/error]

## Rubric (scoped from <kit>'s rubric; omit this section if there is none)
- [each rubric block and its pass bar, kept to the blocks this flow exercises]
```

## `reference-specs/` and `logo.svg`

- Put a readable Markdown copy of every source the brief binds to or cites
  into `reference-specs/`: the token export (`tokens.md`), the cited
  design-language sections, and any spec, ADR, tracker issue or schema
  excerpt. Without a kit, also include the component-library pages that
  document the binding primitives. A source left in the repository is
  invisible to the session.
- Copy the product's logo mark from the kit's assets as `logo.svg`. Without a
  kit, take it from the repository's own brand assets; if there is none, leave
  `logo.svg` out and say so in `01`.
