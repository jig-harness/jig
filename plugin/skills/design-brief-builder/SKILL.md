---
name: design-brief-builder
description: "Prepare a numbered brief for an external design session, derive its facts, and merge the returned bundle against repository fixes before a mechanical browser landing check. Use for external design preparation and handback."
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# Design brief builder

Carries out the preparation and handback of the Claude Design workflow: turning a
user-interface request into the numbered `uploads/` bundle you hand to an
external Claude Design session. The design work itself happens in that
session; this skill produces the *inputs* and runs the audit gate that decides
whether they are ready to submit. It runs the first step of the
design-prototype loop in Jig's feature-delivery pipeline module
([M6](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/README.md)).
The bundle targets Claude Design, the one external design tool supported so
far, and its upload limits shape the bundle.

**Not this skill:** generating a prototype inside the repository, turning a
finished design bundle into code, or tuning an already-built view to match a
prototype. Use the repository's own skills for those, if it has them.

## Paths and working directory

`${CLAUDE_SKILL_DIR}` below stands for the absolute path of the directory
containing this `SKILL.md`. Claude Code fills it in. In any other harness
(Codex, for example), replace it with that path yourself before reading a
file or running a command: a shell would expand the unset variable to an empty
string. The reference files under `references/` write the same directory as
`<skill-dir>`.

Run every command from the root of the repository whose interface the brief
is for. Never `cd` into the skill directory.

## Consumer configuration

The repository's design sources are read from its Jig configuration
(every layer, `.config/jig.yaml` among them) with
`bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" design_brief --json`;
exit 2 means no layer sets the section. The preparation fields below are
optional; the handback fields under `design_brief.handback` are listed in
§ After the session: handoff back, and four of them are required for the
landing check:

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `design_brief.kit` | Directory of the repository's design kit: its README (voice, tone, non-negotiables), its color and type stylesheet, its rubric, its component previews and its logo assets | Detected: a tracked directory whose name ends in `design-kit` or `design_kit` (`git ls-files`). None: gather the same material from the design-language document and the component library, and say in `01` that there is no kit |
| `design_brief.design_language` | The design-language document: the written canon for layout, density, typography, icons, help affordances and copy | Detected: the first tracked `*design-language*.md` or `*design-system*.md`. None: bind only what the kit or the component library shows, and note the gap in `04` |
| `design_brief.prototypes` | Directory where finished design bundles land, one per flow (`<prototypes>/<flow-slug>/`); earlier bundles there count as canonical primitives | None: there are no prior bundles to reuse; ask the user where the finished bundle should land |

Below, "the kit", "the design language" and "the prototypes directory" mean
these values.

## When to use (and not)

Use this skill when the answer to "should we run Claude Design?" is already
**yes** and the next step is assembling the brief. Confirm the yes first:

- ✅ New screens, interface-heavy flows with real interaction design, variant
  exploration.
- ❌ Drift fixes on existing screens (use the repository's design-language
  review, if it has one), backend work, pure copy changes.
- ❌ A flow leaning on interface chrome the kit still lacks: check the kit's
  notes on known gaps, if it has any, before committing a round.

If the flow touches both the interface and the backend, scope the brief to the
**interface slice only**.

## The brief bundle

Assemble in a scratch folder outside the repository,
`/tmp/design-brief-<flow-slug>/uploads/`. **Markdown and
images only**: Claude Design's upload interface rejects
`.yaml`/`.yml`/`.json`/spreadsheets.

The canonical numbering is `00`–`05`. A *creative* brief collapses this to a
four-file variant (`00` folded into `01`, slot `03` deliberately **empty**),
because a structured `03` spec fights the "argue your layout" prompt in `04`.
Pick per the brief type:

| File | Purpose | Full brief | Creative brief |
|------|---------|:---:|:---:|
| `00-design-system-brief.md` | Voice, tone, non-negotiables (from the kit's README; without a kit, from the design language) | ✅ | fold into `01` |
| `01-component-inventory.md` | Binding primitives (from the kit, or the component library without one), anti-invent rules, icon, layout and type rules | ✅ | ✅ |
| `02-tokens-and-colors.md` | Color tokens (pointer to the token export in `reference-specs/`, don't redefine; exported from the kit's stylesheet, or without a kit from the stylesheet or theme file the component library takes its tokens from), status enums, accessibility rules | ✅ | ✅ |
| `03-target-<flow>.md` | **Entity facts only**: data shape, never structure or layout | optional | **empty** |
| `04-target-requirements.md` | Persona, scope, **open design decisions ("argue X")**, hard constraints, anti-patterns, deliverables | ✅ | ✅ |
| `05-success-criteria.md` | Quantitative and qualitative bars, Tweaks scenario list, rubric (scoped from the kit's rubric, if it has one) | ✅ | ✅ |
| `reference-specs/*` | A readable copy of every source the brief binds to or cites: the token export, the cited design-language sections, specs, ADRs, tracker issues, schema excerpts | ✅ | ✅ |
| `logo.svg` | The product's logo mark from the kit, or without a kit from the repository's own brand assets; omit it if there is none | optional | optional |

An ADR is an [architecture decision record](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): a short numbered document that
records one design decision and its reason.

The bundle is the external session's only input: it cannot read the
repository. Include every source the brief binds the design to in the bundle,
and point every citation at the included copy, never at a repository path.

Copy-paste scaffolds with placeholders and inline guidance:
**`${CLAUDE_SKILL_DIR}/references/bundle-templates.md`**.

## Procedure

The overall pattern has three phases: **design freely → reality-check →
additive addendum**. This skill covers the *preparation* that precedes it.
Two orderings, chosen by how familiar the domain is:

- **Familiar surface** → design first. Write `04`/`05` with open creative
  latitude, submit, then run the Phase 2 reality audit *after* the first
  design lands (grounding usually *validates* design intent).
- **Unfamiliar domain** (billing, integrations, a schema you don't know) →
  **audit first**. Run the reality audit *before* the brief, then bake the
  schema reality into `03`/`04` and keep `04`'s open-decisions section intact.

Steps:

1. **Confirm the yes** and pick a full or creative brief. Fix the
   `<flow-slug>` (kebab-case, entity first).
2. **Bind the invariants.** Fill `01`/`02` from the kit and the design
   language. List only *already-canonical* primitives (from the kit and the
   earlier bundles in the prototypes directory) so reuse is the default. Never
   invent primitive names here.
3. **Reality-ground** (audit first, or defer to Phase 2). Generate data-facts tables from source commands before writing counts:
   `bun "${CLAUDE_SKILL_DIR}/scripts/handback.ts" facts '["bun","scripts/export-design-facts.ts"]' "/tmp/design-brief-<flow-slug>/uploads/reference-specs/data-facts.md"`.
   The consumer command returns a nonempty JSON object; the output records its
   argument array, UTC timestamp and source-output digest. Do not hand-count
   entity cardinalities. Two reality-grounding tables with `file:line` citations, one for the entity's content and one for AI and
   automation, each row
   `prototype expectation | backend reality | congruent? | gap`. Procedure and
   grep recipes: **`${CLAUDE_SKILL_DIR}/references/reality-grounding.md`**.
4. **Frame the creative ask** in `04`. Every open choice gets an explicit
   "**argue your choice**" or "pick one and defend it" prompt. This is the
   single highest-value pattern: without it, Claude Design defaults to
   formalization. Draw the line between binding and open deliberately.
5. **Write success criteria** in `05`: quantitative bars (above-the-fold
   density, viewport target, keyboard coverage), qualitative ones
   ("recognizable as <product>, not a generic web-app template"), and a Tweaks
   scenario list (at least 3 meaningful states the prototype can be switched
   between).
6. **Run the anti-prescription audit (mandatory gate).** Five minutes at most.
   Cut every leaked answer before submitting. Full checklist, grep and worked
   before/after example:
   **`${CLAUDE_SKILL_DIR}/references/anti-prescription-audit.md`**.
7. **Submit.** Only after the audit passes.

## Anti-prescription audit: the gate

A brief that pre-bakes the solution produces formalization, not design work:
the designer rotates around your pre-baked answer instead of thinking, which
costs a whole round and all the tokens it spends. Before declaring any bundle
ready, grep for the four prescription smells:

1. **Named primitives** the brief invents (as opposed to already-canonical
   bindings): describe the *design problem*, list only binding primitives.
2. **"Best for X" / "Strong default" / "I propose"** hedges: cut the answer,
   keep the question.
3. **Pre-baked taxonomies** ("widgets A + B + C share shape Y"): ask the
   designer to *discover* the shared shapes.
4. **Per-primitive visual recipes** in `02` (hue logic, segment counts):
   tokens *bind*; primitive visuals stay *open*.

```bash
grep -riE 'best for|strong default|i propose|use a |introduce a ' /tmp/design-brief-<slug>/uploads/*.md
```

The binding-versus-open line, the five-step audit and a worked before/after
example are in `${CLAUDE_SKILL_DIR}/references/anti-prescription-audit.md`.
Read it before your first brief.

## After the session: handoff back

Follow the canonical handback procedure in
`${CLAUDE_SKILL_DIR}/README.md`. Save the landed commit, commit the untouched
raw returned bundle at its canonical path, then run:

```sh
bun "${CLAUDE_SKILL_DIR}/scripts/handback.ts" merge "<bundle>" HEAD "<scratch-output>" --ours "<saved-landed-commit>"
```

This merges the recorded raw export base, saved repository version and returned
export into a new scratch directory. Exit 1 means conflicts or lost repository
hunks need review. Replace the canonical bundle directory with the staged one, so files the
merge deleted are gone too, and run the landing check below
immediately, before manual review, to list mechanical findings. Resolve
conflicts, clear each resolved conflict entry in
`handback-report.json`, and explicitly acknowledge each reported regression
only after deciding whether the repository fix should be restored. Retain the raw export commit in history,
and run the sole landing check:

```sh
bun "${CLAUDE_SKILL_DIR}/scripts/handback.ts" check "<bundle>"
```

Configure `design_brief.handback` through the shared configuration reader:
`forbidden_terms` (default empty), and required `widths`, `rubric`, `scorecard`,
`browser_executable`. Scenario names, URLs and ready selectors come from the
bundle's `design-handback.json`, never a built-in scenario list. Its README and
the consumer scorecard each state exactly one `Bar outcome: pass`, and the
scorecard names the round it reviewed with `Reviewed export base: <commit>`.
Missing evidence, browser availability or unresolved review fails closed. A passed landing check allows
planning production implementation with the repository's own process.

## References

- `${CLAUDE_SKILL_DIR}/references/bundle-templates.md`: copy-paste scaffolds
  for `00`–`05` with placeholders.
- `${CLAUDE_SKILL_DIR}/references/reality-grounding.md`: Phase 2 audit tables
  and schema grep recipes.
- `${CLAUDE_SKILL_DIR}/references/anti-prescription-audit.md`: the four
  smells, the binding-versus-open line, the five-step gate, a worked example.
