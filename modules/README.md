# Modules

The 13 practice modules. Each adopts independently at three maturity levels
(Lite / Standard / Strict — see [principle 2](../principles/02-modular-profile-composed.md))
and converges on the same directory contract (defined in [AGENTS.md](../AGENTS.md)):
`README.md`, `templates/`, `reference/`, `mappings.md`, `maturity.yaml`.

| Module | Practice area | Kernel status |
|--------|---------------|---------------|
| [M0 Instruction architecture](M0-instruction-architecture/) | Layered agent-instruction files, conditional rules, glossary, dispositions | ported (full contract) |
| [M1 Gates & enforcement ladder](M1-gates-enforcement-ladder/) | Quality gates, hooks, grep gates, CI authority, suppression registry | ported (full contract) |
| [M2 Generated-artifact freshness](M2-generated-artifact-freshness/) | Drift gates for anything derived from a source of truth | ported (full contract) |
| [M3 Change-area catalog](M3-change-area-catalog/) | Path→implication mapping as SSoT with generated projections | ported (full contract) |
| [M4 Docs-as-wiki governance](M4-docs-governance/) | Schema-validated docs tree, generated index, retrospection, de-scarring | ported (full contract) |
| [M5 ADR practice](M5-adr-practice/) | Decision records: numbering gate, amendments, decisions-become-checks | ported (full contract) |
| [M6 Feature-delivery pipeline](M6-feature-delivery-pipeline/) | Research → PRD → architecture → design loop → epic, with per-stage review | stub |
| [M7 PR lifecycle & review](M7-pr-lifecycle-review/) | Draft PRs, layered reviewers, comment-resolution loop, HITL merge | ported (full contract) |
| [M8 Learning loop](M8-learning-loop/) | Miss→lens flywheel, eval corpus, reflection, memory promotion | ported (full contract) |
| [M9 Tasks & memory](M9-tasks-memory/) | Tracker taxonomy with process-driving labels; persistent agent memory | stub |
| [M10 Environments & deploy](M10-environments-deploy/) | PR gates → verify → deploy → promote; ephemeral envs; test-data factory | stub |
| [M11 Process observability](M11-process-observability/) | Telemetry on the delivery process itself (review quality, gate health) | stub |
| [M12 Parallel-agent ergonomics](M12-parallel-agent-ergonomics/) | Multiple agents, one machine/repo: ports, mutexes, branch discipline | stub |

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

Scoring: each criterion is observed as `absent`, `convention` (stated in
prose or habit only), or `mechanical` (a hook, CI job, or script enforces
it). A repo attains a maturity level when every criterion at that level *and
below* scores at or above its `requires`. `requires: mechanical` criteria
are what separate Standard/Strict rungs from documentation theater.
