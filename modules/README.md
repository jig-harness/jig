# Modules

The 13 practice modules. Each adopts independently at three maturity levels
(Lite / Standard / Strict — see [principle 2](../principles/02-modular-profile-composed.md))
and carries the same directory contract: `README.md`, `templates/`,
`reference/`, `mappings.md`, `maturity.yaml`. The contract, the README order
and the facts to keep consistent across modules are in [AGENTS.md](AGENTS.md).

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
M1 → M2 → M0 → M4 — but the [audit](../audit/) report's recommendation
sequence overrides any generic ordering.

## `maturity.yaml` schema

Every module's `maturity.yaml` uses one format, so the [auditor](../audit/)
can score any module the same way. Criteria are observable repo facts (a file
exists, a CI job is present, a hook is configured) — never judgments of
quality — and each is scored on the enforcement ladder (see
[GLOSSARY.md](../GLOSSARY.md)): `absent` → `convention` → `mechanical`.

```yaml
module: M1                        # module id
name: gates-enforcement-ladder    # module directory suffix
criteria:
  - id: gate-set-documented       # stable slug, unique within the module
    level: lite                   # rung where this first becomes required:
                                  #   lite | standard | strict
    requires: convention          # minimum score to pass: convention | mechanical
    statement: >-                 # the criterion as one plain-language sentence
      An ordered gate set is stated in one canonical place and runnable
      with a single command.
    observe:                      # what the auditor actually looks for
      - "instruction file lists the ordered gates"
      - "one script/task runs them all"
```

Scoring: each criterion is *observed* on the enforcement ladder as `absent`,
`convention` (stated in prose or habit only), `advisory` (a check runs
mechanically but cannot block — a non-blocking CI step; see
[GLOSSARY.md](../GLOSSARY.md)), or `mechanical` (a hook, CI job, or review
gate enforces it). The `requires` field is the *pass bar* and takes only
`convention` or `mechanical`: a criterion needing `mechanical` is **not** met
by an `advisory` observation (that is precisely a gate to promote). A repo
attains a maturity level when every criterion at that level *and below* is
observed at or above its `requires`. `requires: mechanical` criteria are what
separate Standard/Strict rungs from documentation theater.
