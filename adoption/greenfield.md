# Greenfield adoption

Starting a new project with Jig from day one. The entry point is a
**structured kickoff** that produces the first delivery artifacts, followed by
adopting the profile's modules at their target maturity from the start.

Two pieces cooperate:

- the **kickoff methodology** in [seeds/project-kickoff/](../seeds/project-kickoff/)
  — an 11-phase bootstrap that takes a project from "an idea" to "tracker
  populated, ready to build";
- the **modules** — the operating system for everything after the kickoff ends,
  led by [M6](../modules/M6-feature-delivery-pipeline/), whose
  [templates](../modules/M6-feature-delivery-pipeline/templates/) are the
  canonical form of the artifacts the kickoff's discovery phases produce.

Where the seed and a module disagree, the **module wins** — the seed is the
imported starting point; the modules carry the maintained contract.

## The 11 kickoff phases, mapped to modules

The kickoff's phases each produce an artifact or scaffold that a module governs
from then on. Run the phases; reach for the mapped module's template and gates
as you go.

| Kickoff phase | Produces | Module + template it maps to |
|---------------|----------|------------------------------|
| 1. Requirements discovery | first PRD draft | [M6](../modules/M6-feature-delivery-pipeline/) — [`prd-template.md`](../modules/M6-feature-delivery-pipeline/templates/prd-template.md) (*what* for users) |
| 2. Technical architecture | first architecture draft | [M6](../modules/M6-feature-delivery-pipeline/) — [`architecture-template.md`](../modules/M6-feature-delivery-pipeline/templates/architecture-template.md) (*how*) |
| 3. Critical analysis (**fresh session**, red-team) | critique of 1–2 | [M6](../modules/M6-feature-delivery-pipeline/)'s per-stage **adversarial review** — the fresh-context reviewer *is* this phase, made routine |
| 4. Synthesis | accepted PRD + architecture | [M6](../modules/M6-feature-delivery-pipeline/) — de-scar and mark `accepted` (the [stage-review-record gate](../modules/M6-feature-delivery-pipeline/reference/stage-review-record/)) |
| 5. Repo bootstrap (instruction file, gates, plan) | the scaffolding spine | [M0](../modules/M0-instruction-architecture/) (instruction file + [glossary](../GLOSSARY.md)), [M1](../modules/M1-gates-enforcement-ladder/) (gate set + [CI](../GLOSSARY.md)), [M2](../modules/M2-generated-artifact-freshness/) (derived-file inventory) |
| 6. Plan review | validated master plan | [M6](../modules/M6-feature-delivery-pipeline/) adversarial review, applied to the plan |
| 7. Human development guide | contributor-facing docs | [M4](../modules/M4-docs-governance/) (docs governance) |
| 8. Scaffold the project | running skeleton | stack-specific (derive the stack; not a Jig module) |
| 9. Nested instruction files | per-directory rules | [M0](../modules/M0-instruction-architecture/) (per-directory instructions, tool deltas as pointers) |
| 10. Implementation planning (**review each plan**) | epic + phase plans | [M6](../modules/M6-feature-delivery-pipeline/) epic decomposition + [M9](../modules/M9-tasks-memory/) tactical plans |
| 11. Populate the tracker | filed, labelled work | [M9](../modules/M9-tasks-memory/) — label taxonomy + [issue templates](../modules/M9-tasks-memory/templates/ISSUE-TEMPLATES.md); [flag labels](../GLOSSARY.md) set here drive downstream gates |

The kickoff's Lite/Standard/Enterprise tiers map directly onto Jig's
[profiles](../profiles/) — pick the profile during phase 5 and adopt its modules
at their target maturity from the start.

## The shape, in three moves

1. **Run the kickoff** ([seeds/project-kickoff/](../seeds/project-kickoff/)),
   reaching for each mapped module's template above. The two discovery outputs
   (PRD, architecture) come from [M6](../modules/M6-feature-delivery-pipeline/)'s
   templates, and the phase-3 red-team pass is M6's per-stage adversarial review
   done in a **fresh session** — an agent that just wrote a doc will defend it,
   so the reviewer starts clean.
2. **Pick a profile and adopt its modules at target maturity** during the
   repo-bootstrap phase: instruction file + glossary ([M0](../modules/M0-instruction-architecture/)),
   gate set + CI ([M1](../modules/M1-gates-enforcement-ladder/)), derived-file
   inventory ([M2](../modules/M2-generated-artifact-freshness/)), and — for
   Team/Standard and up — docs governance ([M4](../modules/M4-docs-governance/)),
   ADRs ([M5](../modules/M5-adr-practice/)), the delivery pipeline
   ([M6](../modules/M6-feature-delivery-pipeline/)), the PR loop
   ([M7](../modules/M7-pr-lifecycle-review/)), and tracker discipline
   ([M9](../modules/M9-tasks-memory/)).
3. **Wire the learning loop early** (even Lite): a place to file misses and the
   habit of turning them into checks ([M8](../modules/M8-learning-loop/)) costs
   almost nothing on day one and compounds forever. If you run several agents on
   one machine, adopt [M12](../modules/M12-parallel-agent-ergonomics/)'s port
   allocator and heavy-run mutex before the collisions start.

## Why kickoff + modules, not just kickoff

The kickoff methodology ends where a project *starts* (tracker populated, plans
reviewed). The modules are the operating system for everything after: keeping
instructions fresh, gates honest, docs governed, reviews layered, and the
process learning. Greenfield projects get both for the price of following the
kickoff's bootstrap phases with the module templates at hand — the kickoff
bootstraps, and [M6](../modules/M6-feature-delivery-pipeline/)'s pipeline is what
every feature *after* the first one flows through.
