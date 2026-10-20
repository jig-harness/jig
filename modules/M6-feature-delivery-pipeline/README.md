# M6 — Feature-delivery pipeline

**What problem this solves.** Without a named pipeline, features skip stages ad
hoc: architecture gets decided inside a pull request, requirements live in a
chat thread, design feedback arrives after the thing is already built, and each
artifact is reviewed late or never. Nobody set out to work that way — it is what
happens when "how an idea becomes shipped work" is tribal knowledge instead of a
written contract. This module codifies the idea→shipped flow — research spike →
[PRD](../../GLOSSARY.md) → architecture → design-prototype loop → epic
decomposition — with a real review at every stage and a clean artifact handed to
the next one.

## Invariant

> Each stage produces a **named artifact from a committed template**; each
> artifact is **adversarially reviewed** (fresh context, red-team posture) and
> **[de-scarred](../../GLOSSARY.md)** before the next stage consumes it;
> significant decisions become **[ADRs](../../GLOSSARY.md)**; and the
> **design-prototype loop is allowed to feed back** into requirements and
> architecture rather than being a rendering step at the end.

Everything below is one tool-independent statement made mechanical where it can
be; concrete per-ecosystem wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **Named stages, each with its template** — research spike → PRD →
   architecture → design-prototype loop → epic decomposition. The copyable
   narrative contract is [`PIPELINE.md`](templates/PIPELINE.md); each stage
   produces one named artifact from a committed skeleton —
   [`research-note-template.md`](templates/research-note-template.md),
   [`prd-template.md`](templates/prd-template.md),
   [`architecture-template.md`](templates/architecture-template.md). The PRD
   carries *what* for users (no stack talk); the architecture carries *how*.
2. **Per-stage adversarial review + de-scar** — before an artifact is handed
   onward, a reviewer with **fresh context** and a **red-team posture** critiques
   it (gaps, ambiguities, unstated assumptions, risks); the team iterates until
   findings clear, then **de-scars** — the finished artifact carries no
   finding-lists or reviewer dialogue, only the result (see
   [M4](../M4-docs-governance/)). An artifact is either a draft you are shaping
   or an accepted input the next stage trusts — there is no third state.
3. **Committed templates, made mechanical** — "use the template" is a habit
   until a gate checks it. The [required-sections gate](reference/required-sections/)
   fails a stage artifact missing a required heading (a PRD with no
   `## Success metrics`), so each stage genuinely produces its named artifact
   from the committed skeleton.
4. **Acceptance proves review happened** — flipping an artifact to
   `status: accepted` (the "next stage may consume this" mark) requires a review
   record: a `reviewed:` frontmatter key with a reviewer + date/ref, or a
   non-empty `## Review` section. The
   [stage-review-record gate](reference/stage-review-record/) makes the review
   non-skippable — the status word cannot outrun the work it stands for.
5. **Decisions become ADRs** — the architecture doc describes the shape; each
   weighty, hard-to-reverse choice is captured as its own numbered ADR (see
   [M5](../M5-adr-practice/)), and a research note that changes a decision
   graduates into one too — so the decision and its consequences outlive the doc
   that prompted them.
6. **The design-prototype loop feeds back** — for UI work, a design is
   prototyped and adversarially reviewed *before* the build, and what it teaches
   is allowed to reopen the PRD and the architecture. A prototype routinely
   surfaces product truths the written PRD missed; treating the loop as a source
   of requirements — not a late rendering step — is the point. The accepted
   prototype is then imported in a standard, reusable form and the architecture
   re-checked.
7. **Epic decomposition hands off to delivery** — the accepted artifacts are
   decomposed into an epic of sub-issues, each with a tactical plan and
   [flag labels](../../GLOSSARY.md) (`has-migration`, `api-change`, `ui`,
   `hitl`, …). The labels *drive process*: they select which reviews and gates
   fire once the work reaches a pull request — the taxonomy lives in
   [M9](../M9-tasks-memory/) and [M3](../M3-change-area-catalog/), and the PR
   loop that consumes them is [M7](../M7-pr-lifecycle-review/).

## Maturity levels

- **Lite** — the pipeline stages are named in one document (a convention), and
  committed PRD, architecture, and research-note templates exist. Review and
  de-scarring may be convention; nothing is gated yet.
- **Standard** — each stage produces a named artifact **from the committed
  template**, and the [required-sections gate](reference/required-sections/)
  checks it mechanically on changed stage docs; per-stage adversarial review is
  a documented contract; de-scarring is applied (the finished artifact is clean
  — see [M4](../M4-docs-governance/)).
- **Strict** — the [required-sections](reference/required-sections/) and
  [stage-review-record](reference/stage-review-record/) gates run in
  [CI](../../GLOSSARY.md) with their self-tests (mechanical); epic decomposition
  sets flag labels that drive downstream gates (mechanical, via
  [M9](../M9-tasks-memory/) / [M3](../M3-change-area-catalog/)); and the
  design-prototype loop's feedback into requirements and architecture is a
  written contract.

## Adoption steps

1. Copy [`PIPELINE.md`](templates/PIPELINE.md) into your docs tree and name the
   stages for your project; adjust the tool-specific bits.
2. Copy the three artifact templates
   ([`prd-template.md`](templates/prd-template.md),
   [`architecture-template.md`](templates/architecture-template.md),
   [`research-note-template.md`](templates/research-note-template.md)) and point
   your PRD/architecture/research homes at them.
3. Adopt the [required-sections gate](reference/required-sections/): write one
   sections manifest per artifact type and run it against changed stage docs
   (recipes in [mappings.md](mappings.md)).
4. Adopt the [stage-review-record gate](reference/stage-review-record/) as a
   merge gate so an artifact cannot reach `status: accepted` without a review
   record.
5. Wire epic decomposition to your tracker's [flag labels](../../GLOSSARY.md)
   ([M9](../M9-tasks-memory/) / [M3](../M3-change-area-catalog/)) so the labels
   set here steer the PR loop ([M7](../M7-pr-lifecycle-review/)).

## Status

What this module provides:

- [`templates/PIPELINE.md`](templates/PIPELINE.md) — the copyable stage
  contract: stage order, per-stage review and de-scar, and the design loop's
  feedback upstream.
- [`templates/prd-template.md`](templates/prd-template.md) — *what* for users,
  with a required `## Success metrics`.
- [`templates/architecture-template.md`](templates/architecture-template.md) —
  *how*; significant decisions link out to ADRs.
- [`templates/research-note-template.md`](templates/research-note-template.md)
  — a dated note with context, options, evidence and a recommendation;
  decisions graduate to ADRs.
- [`reference/required-sections/`](reference/required-sections/) — fails a
  stage artifact that is missing a required heading.
- [`reference/stage-review-record/`](reference/stage-review-record/) — fails an
  artifact marked `status: accepted` that carries no review record.
- [`mappings.md`](mappings.md) (agent runtimes, issue trackers, doc and
  template homes, CI) and the module's [maturity criteria](../../plugin/skills/audit/criteria/M6-feature-delivery-pipeline.yaml).

Both gates have paired self-tests and fixtures beside them. The
[`/jig:design-brief-builder`](../../plugin/skills/design-brief-builder/SKILL.md)
skill prepares the design-prototype loop's brief and audits it before the
external session starts. It also merges the returned bundle with repository
fixes and runs its mechanical landing checks before acceptance.

Deliberately left out: tiered time estimates, named critique personas, a
model-routing table and specific tool picks (a named tracker, named
scaffolding commands). They are one team's tuned choices, not a portable
mechanism; the module keeps the stage contract and the two gates, and leaves
tool selection to [mappings.md](mappings.md). Requirement IDs (`FR-1`,
`NFR-1`) appear in the templates as a light, optional convention.
