# Modules

The 13 practice modules. Each adopts independently at three maturity levels
(Lite / Standard / Strict — see [principle 2](../principles/02-modular-profile-composed.md))
and carries the same directory contract: `README.md`, `templates/`,
`reference/`, `mappings.md`, and its [maturity criteria](#maturity-criteria) in
the audit skill. The contract, the README order and the facts to keep
consistent across modules are in [AGENTS.md](AGENTS.md).

The last column names the [plugin](../plugin/README.md) skills that run a
module's practice for you; a module without one is adopted from its templates
and reference gates.

| Module | Practice area | Runnable in the plugin |
|--------|---------------|------------------------|
| [M0 Instruction architecture](M0-instruction-architecture/) | Layered agent-instruction files, conditional rules, glossary, dispositions | — |
| [M1 Gates & enforcement ladder](M1-gates-enforcement-ladder/) | Quality gates, hooks, grep gates, CI authority, suppression registry | [`fix-ci`](../plugin/skills/fix-ci/SKILL.md), [`github-actions`](../plugin/skills/github-actions/SKILL.md) |
| [M2 Generated-artifact freshness](M2-generated-artifact-freshness/) | Drift gates for anything derived from a source of truth | — |
| [M3 Change-area catalog](M3-change-area-catalog/) | Path→implication mapping as SSoT with generated projections | [`review`](../plugin/skills/review/SKILL.md) reads the catalog |
| [M4 Docs-as-wiki governance](M4-docs-governance/) | Schema-validated docs tree, generated index, retrospection, de-scarring | [`descar`](../plugin/skills/descar/SKILL.md), [`explain`](../plugin/skills/explain/SKILL.md) |
| [M5 ADR practice](M5-adr-practice/) | Decision records: numbering gate, amendments, decisions-become-checks | [`adr`](../plugin/skills/adr/SKILL.md), [`decide`](../plugin/skills/decide/SKILL.md) |
| [M6 Feature-delivery pipeline](M6-feature-delivery-pipeline/) | Research → PRD → architecture → design loop → epic, with per-stage review | [`design-brief-builder`](../plugin/skills/design-brief-builder/SKILL.md) |
| [M7 PR lifecycle & review](M7-pr-lifecycle-review/) | Draft PRs, layered reviewers, comment-resolution loop, HITL merge | [`drive-pr`](../plugin/skills/drive-pr/README.md), [`resolve-review-comments`](../plugin/skills/resolve-review-comments/README.md), [`resolve-conflicts`](../plugin/skills/resolve-conflicts/SKILL.md), [`review`](../plugin/skills/review/SKILL.md), [`review-arbiter`](../plugin/agents/review-arbiter.md) |
| [M8 Learning loop](M8-learning-loop/) | Miss→lens flywheel, eval corpus, reflection, memory promotion | [`promote-memory`](../plugin/skills/promote-memory/SKILL.md) |
| [M9 Tasks & memory](M9-tasks-memory/) | Tracker taxonomy with process-driving labels; persistent agent memory | [`do-item`](../plugin/skills/do-item/SKILL.md) |
| [M10 Environments & deploy](M10-environments-deploy/) | PR gates → verify → deploy → promote; ephemeral envs; test-data factory | [`github-actions`](../plugin/skills/github-actions/SKILL.md) |
| [M11 Process observability](M11-process-observability/) | Telemetry on the delivery process itself (review quality, gate health) | [`drive-pr`](../plugin/skills/drive-pr/README.md)'s loop and fleet metrics |
| [M12 Parallel-agent ergonomics](M12-parallel-agent-ergonomics/) | Multiple agents, one machine/repo: ports, mutexes, branch discipline | — |

Adoption ordering for brownfield projects is leverage-first — typically
M1 → M2 → M0 → M4 — but the [audit](../plugin/skills/audit/README.md) report's recommendation
sequence overrides any generic ordering.

## Maturity criteria

Each module's maturity criteria are observable repository facts the
[audit skill](../plugin/skills/audit/README.md) scores, in one file per module
under [`plugin/skills/audit/criteria/`](../plugin/skills/audit/criteria/),
where the plugin can read them from any repository. Their format, how they
are scored and how a level is attained are in that folder's
[README](../plugin/skills/audit/criteria/README.md). Each module README links
its own file.
