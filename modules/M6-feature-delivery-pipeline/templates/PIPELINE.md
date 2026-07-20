# Feature-delivery pipeline

> TEMPLATE — copy to your repo (e.g. `docs/development/feature-delivery-pipeline.md`)
> and adjust the tool-specific bits (the `<...>` parts). This is the narrative
> contract for how a feature moves from an idea to shipped work. The executable
> steps (skills, gates, trackers) are referenced, not restated. Invariant it
> encodes: **each stage produces a named artifact from a committed template;
> each artifact is adversarially reviewed — fresh context, red-team posture —
> and de-scarred before the next stage consumes it; the design-prototype loop is
> allowed to feed back into requirements and architecture.**

## The flow

```text
(idea)
  → research spike ....... research note   (research-note-template.md)
  → requirements ......... PRD             (prd-template.md)
  → architecture ......... architecture doc (architecture-template.md) + ADRs
  → design-prototype loop  accepted prototype   (UI work only; may feed back ↑)
  → epic decomposition ... epic + flag-labelled sub-issues  → hands off to delivery
```

Each stage below states the **named artifact** it produces, the **template** it
comes from, its **adversarial review**, and its **exit condition**. You do not
advance until the exit condition holds. A stage may be skipped when it does not
apply (no research needed; no UI to prototype) — but when a stage runs, it runs
whole.

## The rule that repeats at every stage

Before an artifact is handed to the next stage:

1. **Adversarial review.** A reviewer with **fresh context** and a **red-team
   posture** critiques the artifact — gaps, ambiguities, unstated assumptions,
   risks. Fresh context matters: an agent that just wrote the artifact will
   defend it, so the reviewer starts clean rather than anchored to the drafting
   conversation. Iterate until the findings are cleared.
2. **De-scar.** Fold the accepted changes into the artifact and remove the
   review scars — finding lists, reviewer dialogue, "addressed" annotations. The
   finished artifact reads as if it were right the first time; the history lives
   in the review threads, issues, and git (see
   [M4](../../M4-docs-governance/)).
3. **Mark accepted.** Set the artifact's `status: accepted` and record the
   review (a `reviewed:` frontmatter key with a reviewer + date/ref, or a
   non-empty `## Review` section). Only now may the next stage consume it.

The review is not optional politeness — it is the seam between stages. An
artifact is either a draft you are still shaping or an accepted input the next
stage trusts; there is no third state.

## 1. Research spike (when a decision is unclear)

When a stage would otherwise proceed on a guess — an unknown feasibility, an
unclear trade-off, a "which approach?" — open a **research spike** first.

- **Artifact:** a dated **research note**, from
  [`research-note-template.md`](research-note-template.md): context, options,
  evidence, recommendation.
- **Adversarial review:** challenge the evidence and whether the recommendation
  follows from it, not just the conclusion.
- **Graduation:** a research note that *changes a decision* graduates into an
  [ADR](../../GLOSSARY.md) (see [M5](../../M5-adr-practice/)). The note captures
  the exploration; the ADR captures the decision the project now lives by.

**Exit:** a dated research note with a recommendation; any decision it settles
is written as an ADR.

## 2. Requirements — the PRD

- **Artifact:** a **[PRD](../../GLOSSARY.md)** (product requirements document),
  from [`prd-template.md`](prd-template.md).
- **Content:** *what* the feature does for users and why — personas,
  requirements, success metrics, scope. **No stack talk** here: databases,
  frameworks, and infrastructure belong to the architecture stage. Keeping
  *what* separate from *how* is what lets each be reviewed on its own terms.
- **Required sections** are enforced by the
  [required-sections gate](../reference/required-sections/) so "use the
  template" is mechanical, not a habit.
- **Adversarial review:** a red-team pass for gaps, vague requirements,
  unmeasurable success metrics, and scope that has quietly crept.

**Exit:** an accepted PRD (all required sections present, reviewed, de-scarred).

## 3. Architecture

- **Artifact:** an **architecture doc**, from
  [`architecture-template.md`](architecture-template.md).
- **Content:** *how* the PRD's requirements are met — components, data model,
  interfaces, security, scale. Trace decisions back to the requirements they
  satisfy.
- **Significant decisions become [ADRs](../../GLOSSARY.md).** The architecture
  doc describes the shape; each weighty, hard-to-reverse choice (a storage
  engine, an auth model, a boundary) is captured as its own numbered ADR (see
  [M5](../../M5-adr-practice/)) so the decision and its consequences outlive the
  doc.
- **Adversarial review:** a red-team pass for scalability, security, cost, and
  single points of failure — ideally from a fresh reviewer who has not seen the
  drafting.

**Exit:** an accepted architecture doc; significant decisions recorded as ADRs.

## 4. Design-prototype loop (UI work only)

For features with a user interface, prototype the design **before** committing
to the build — and let what you learn flow back upstream.

```text
design brief → generated/handmade prototype → adversarial design review
            → iterate  ─────────────────────────────────────────────┐
            → (feedback may revise the PRD and/or the architecture) ←─┘
            → accept the prototype → import it in a standard, reusable form
            → re-examine architectural implications
```

- **Artifact:** an **accepted prototype** plus the design decisions it settles.
- **Feedback is the point.** A prototype routinely surfaces product truths a
  written PRD missed and constraints the architecture did not anticipate. When
  it does, **reopen** the PRD or the architecture and revise them — the loop is
  a source of requirements, not a rendering step at the end. Both upstream
  artifacts stay open to revision until the prototype is accepted.
- **Adversarial review:** a strong reviewer critiques the prototype against the
  PRD's user goals and for interaction, accessibility, and edge states.
- **Standard import:** bring the accepted prototype into the codebase in a
  consistent, reusable form (shared components / tokens), then re-check the
  architecture for anything the accepted design implies.

**Exit:** an accepted prototype imported in standard form; any PRD/architecture
revisions it forced are themselves re-reviewed and re-accepted.

## 5. Epic decomposition — the handoff to delivery

- **Artifact:** an **epic** decomposed into sub-issues, each carrying a clear,
  tactical execution plan.
- **Flag labels drive downstream gates.** Tag each sub-issue with the
  [flag labels](../../GLOSSARY.md) that describe what it touches — for example
  `has-migration`, `api-change`, `ui`, `hitl` — so the labels *drive process*:
  they select which reviews and gates fire when the work reaches a pull request.
  The label taxonomy and its process effects live in
  [M9](../../M9-tasks-memory/) (tasks & memory) and
  [M3](../../M3-change-area-catalog/) (change-area catalog).
- **This is where the pipeline hands off** to the PR loop
  ([M7](../../M7-pr-lifecycle-review/)): each sub-issue becomes one or more pull
  requests, and the flag labels set there decide the mandatory reviewers and
  gates.

**Exit:** an epic whose sub-issues each have a plan and the flag labels that
will steer their delivery.

## What connects to what

Every stage names the committed **template** (or skill/command) it runs from —
fill the `<...>` placeholders with your project's concrete tools:

| Stage | Named artifact | From template / tool | Feeds |
|-------|----------------|----------------------|-------|
| Research spike | research note | `research-note-template.md` | the stage that was blocked; decisions → ADRs (M5) |
| Requirements | PRD | `prd-template.md` | architecture, design, epic |
| Architecture | architecture doc + ADRs | `architecture-template.md` | design, epic |
| Design-prototype loop | accepted prototype | `<design-brief-template>` + your `<design-prototype>` skill/tool | back into PRD / architecture; then epic |
| Epic decomposition | epic + flag-labelled sub-issues | M9 `ISSUE-TEMPLATES.md` (epic + sub-issue skeletons), filed via `<tracker>` | the PR loop (M7), via labels (M9 / M3) |

## Where this is not a straight line

The pipeline is a default order, not a one-way street. Two feedbacks are
expected and healthy:

- The **design loop** revises the PRD and architecture (stage 4 → stages 2–3).
- A **research spike** can open at any stage a decision turns out to be unclear
  (→ stage 1), and its result may become an ADR that amends the architecture.

What is *not* negotiable is the seam: whatever a stage hands onward is an
**accepted, reviewed, de-scarred** artifact — never a draft, never an unreviewed
one.
