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

The delivery loop that follows the pipeline is published as **one stage map**,
reachable in one hop from the instructions every session loads: each stage
names its owner and the artifact it hands on, and a gate keeps every named
owner resolvable.

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
   or an accepted input the next stage trusts — there is no third state. For
   the requirements and architecture stages, the
   [`/jig:red-team`](../../plugin/skills/red-team/SKILL.md) skill is the
   runnable form: personas each read the document in fresh context and
   write their findings to one report, which stays with the review while the
   document's [stage-review record](reference/stage-review-record/) cites it.
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

## The lifecycle map

**What goes wrong without it.** The loop from steering to a closed epic is
described in pieces: the pipeline above, the pull-request loop in
[M7](../M7-pr-lifecycle-review/), the tracker rules in
[M9](../M9-tasks-memory/). A session that designs or changes the process
reads the pieces it knows, and the stages nobody pointed it to stay out of
the design. A repository's list of skills does not fix that: it groups skills
by what they are, and "what comes next?" asks for the order they are used in.
The pass that settles what a merge still owes, and the step that closes an
epic, can exist for months without any page sending anyone to them.

The fix is one table, the copyable [`LIFECYCLE.md`](templates/LIFECYCLE.md):

| Stage | Owner | Hands on |
|-------|-------|----------|
| file | `/file-issue` | a labelled tracker issue |

- **One row per stage of the loop**, in the order work takes: steer, spec,
  file, plan the epic, pick up, implement, pre-PR gates, draft and drive,
  review rounds, merge, post-merge, ops drain, epic close, and back to steer.
  A repository drops a stage it does not run and adds one it does.
- **Stages are named, never numbered.** A number is wrong the day a stage is
  added between two others, and every reference to it is wrong with it.
- **Each stage names its owner**: the skill, command, script or document that
  runs it, written so a script can find it. A stage nobody owns says what
  happens instead, with a link, and a person is named by the decision that
  makes them the owner.
- **Each stage names the artifact it hands on**, the thing the next stage
  consumes. A stage whose handoff cannot be named is not yet a stage.
- **The map links into each stage's own document** (the module, the skill's
  README) and does not restate it, so it has nothing of its own to go stale
  but names.
- **It is one hop from the instructions** every session loads: the universal
  instruction file ([M0](../M0-instruction-architecture/README.md)) says what
  to read next, and this is on that list.

The [lifecycle map gate](reference/lifecycle-map/README.md) keeps the names
true: it fails when an owner is a skill, script or file that does not exist,
when a stage is numbered, unowned or still a template placeholder, when the
instruction file stops linking the map, and, for a repository that ships
skills, when a skill is on no stage and no row of the map's table of skills
outside the loop. The same resolution covers any document that names a
skill: a process document that sends a reader to a skill that was renamed
fails the same way. Whether the stages are in the right order stays a
reviewer's question; the template says what to ask.

## Maturity levels

- **Lite** — the pipeline stages are named in one document (a convention), and
  committed PRD, architecture, and research-note templates exist. Review and
  de-scarring may be convention; nothing is gated yet. The delivery loop is
  one [lifecycle map](#the-lifecycle-map) that the universal instruction file
  links.
- **Standard** — each stage produces a named artifact **from the committed
  template**, and the [required-sections gate](reference/required-sections/)
  checks it mechanically on changed stage docs; per-stage adversarial review is
  a documented contract; de-scarring is applied (the finished artifact is clean
  — see [M4](../M4-docs-governance/)); and the
  [lifecycle map gate](reference/lifecycle-map/) runs in CI with its
  self-test and fails a map that names an owner that does not exist.
- **Strict** — the [required-sections](reference/required-sections/) and
  [stage-review-record](reference/stage-review-record/) gates run in
  [CI](../../GLOSSARY.md) with their self-tests (mechanical); epic decomposition
  sets flag labels that drive downstream gates (mechanical, via
  [M9](../M9-tasks-memory/) / [M3](../M3-change-area-catalog/)); and the
  design-prototype loop's feedback into requirements and architecture is a
  written contract; and, for a repository that ships skills, the lifecycle map
  gate requires every one of them on the map.

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
6. Copy [`LIFECYCLE.md`](templates/LIFECYCLE.md) into your docs tree, name the
   owner of each stage, link it from your universal instruction file, and run
   the [lifecycle map gate](reference/lifecycle-map/) (recipe in
   [mappings.md](mappings.md#the-lifecycle-map)).

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
- [`templates/LIFECYCLE.md`](templates/LIFECYCLE.md) — the copyable stage map
  of the delivery loop: owner and handoff per stage, and the table of skills
  outside the loop.
- [`reference/required-sections/`](reference/required-sections/) — fails a
  stage artifact that is missing a required heading.
- [`reference/stage-review-record/`](reference/stage-review-record/) — fails an
  artifact marked `status: accepted` that carries no review record.
- [`reference/lifecycle-map/`](reference/lifecycle-map/) — fails a lifecycle
  map that names a skill, script or document that does not exist, numbers its
  stages, leaves one unowned, or is not linked from the instruction file.
- [`mappings.md`](mappings.md) (agent runtimes, issue trackers, doc and
  template homes, CI) and the module's [maturity criteria](../../plugin/skills/audit/criteria/M6-feature-delivery-pipeline.yaml).

Each gate has a paired self-test and fixtures beside it. The
[`/jig:red-team`](../../plugin/skills/red-team/SKILL.md) skill runs the
adversarial review of a PRD or an architecture document by persona, each in
fresh context, and writes one findings report without editing the document.
The
[`/jig:design-brief-builder`](../../plugin/skills/design-brief-builder/SKILL.md)
skill prepares the design-prototype loop's brief and audits it before the
external session starts. It also merges the returned bundle with repository
fixes and runs its mechanical landing checks before acceptance.

Deliberately left out: tiered time estimates, named critique personas, a
model-routing table and specific tool picks (a named tracker, named
scaffolding commands). They are one team's tuned choices, not a portable
mechanism (the personas Jig's own review uses are in the
[`red-team`](../../plugin/skills/red-team/references/personas.md) skill);
the module keeps the stage contract and its gates, and leaves tool selection
to [mappings.md](mappings.md). The lifecycle map gate checks that
the names in the map resolve; it does not check that the stages are in the
right order, which a reviewer of a change to the process asks of the table.
A map is not generated from the skills' own metadata: the order work takes is
a fact about the process, which no skill states about itself. Requirement IDs (`FR-1`,
`NFR-1`) appear in the templates as a light, optional convention.
