# Modules

The 13 practice modules. Each adopts independently at three maturity levels
(Lite / Standard / Strict — see [principle 2](../principles/02-modular-profile-composed.md))
and converges on the same directory contract (defined in [AGENTS.md](../AGENTS.md)):
`README.md`, `templates/`, `reference/`, `mappings.md`, `maturity.yaml`.

| Module | Practice area | Kernel status |
|--------|---------------|---------------|
| [M0 Instruction architecture](M0-instruction-architecture/) | Layered agent-instruction files, conditional rules, glossary, dispositions | README (substantive) |
| [M1 Gates & enforcement ladder](M1-gates-enforcement-ladder/) | Quality gates, hooks, grep gates, CI authority, suppression registry | README (substantive) |
| [M2 Generated-artifact freshness](M2-generated-artifact-freshness/) | Drift gates for anything derived from a source of truth | README (substantive) |
| [M3 Change-area catalog](M3-change-area-catalog/) | Path→implication mapping as SSoT with generated projections | stub |
| [M4 Docs-as-wiki governance](M4-docs-governance/) | Schema-validated docs tree, generated index, retrospection, de-scarring | stub |
| [M5 ADR practice](M5-adr-practice/) | Decision records: numbering gate, amendments, decisions-become-checks | stub |
| [M6 Feature-delivery pipeline](M6-feature-delivery-pipeline/) | Research → PRD → architecture → design loop → epic, with per-stage review | stub |
| [M7 PR lifecycle & review](M7-pr-lifecycle-review/) | Draft PRs, layered reviewers, comment-resolution loop, HITL merge | stub |
| [M8 Learning loop](M8-learning-loop/) | Miss→lens flywheel, eval corpus, reflection, memory promotion | stub |
| [M9 Tasks & memory](M9-tasks-memory/) | Tracker taxonomy with process-driving labels; persistent agent memory | stub |
| [M10 Environments & deploy](M10-environments-deploy/) | PR gates → verify → deploy → promote; ephemeral envs; test-data factory | stub |
| [M11 Process observability](M11-process-observability/) | Telemetry on the delivery process itself (review quality, gate health) | stub |
| [M12 Parallel-agent ergonomics](M12-parallel-agent-ergonomics/) | Multiple agents, one machine/repo: ports, mutexes, branch discipline | stub |

Adoption ordering for brownfield projects is leverage-first — typically
M1 → M2 → M0 → M4 — but the [audit](../audit/) report's recommendation
sequence overrides any generic ordering.
