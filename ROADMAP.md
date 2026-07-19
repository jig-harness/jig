# Roadmap & Status

The build-out phases come from the founding charter
([docs/founding-charter-2026-07-18.md](docs/founding-charter-2026-07-18.md),
Part V). This file is the **continuation anchor**: a session picking up
groundwork work starts here.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Founding charter (analysis, module map, blueprint) | ✅ done (vendored in `docs/`) |
| 1 | Codification **in docomply**: C1–C9 canonical docs + drift fixes | ✅ done (epic an issue, all 12 sub-issues; artifacts on docomply `develop` — see Port sources) |
| 2 | **Bootstrap groundwork**: skeleton, principles, glossary, profiles outline, auditor v0, port M0–M2 | ✅ done 2026-07-19 (all remainder items closed — see below) |
| 3 | Port M4 docs governance, M5 ADR practice, M3 change-area catalog; add `maturity.yaml` per landed module | ⬜ |
| 4 | Port M7 review-harness core + M8 learning loop | ⬜ |
| 5 | M6/M9/M10/M11/M12, auditor v1 (scored maturity assessment; dogfood re-audit of docomply), greenfield path integrating project-kickoff | ⬜ |
| ∞ | Backflow: evaluate each new reference-implementation lesson for porting | standing |

## Phase 2 remainder (all closed 2026-07-19; next work is Phase 3)

1. ~~**M0–M2 `templates/` + `reference/` + `mappings.md` + `maturity.yaml`**~~
   — ✅ done 2026-07-19: all three modules carry the full contract,
   genericized and IP-scrubbed per AGENTS.md (see each § Port status for
   what was deliberately not ported).
2. ~~**Groundwork's own gates (dogfood M1)**~~ — ✅ done 2026-07-19:
   `./scripts/gates.sh` (self-tests + link check + table check +
   glossary-coverage via acronym proxy) runs locally and in CI on every PR
   (`.github/workflows/gates.yml`).
3. ~~**Auditor calibration**~~ — ✅ done 2026-07-19: full run against
   sindresorhus/execa
   ([report](audit/calibration/2026-07-19-execa.md)); six auditor gaps found
   and fixed (null-result guidance, negative-evidence rule, advisory score
   state, repo-shape weighting, full-clone requirement, bot-wiring evidence
   rule).
4. ~~**Profiles deepening**~~ — ✅ done 2026-07-19 for ported modules:
   profile targets for M0–M2 now resolve to concrete `maturity.yaml`
   criteria (levels named in `profiles/`, criteria stated only in the module
   files); deepens further automatically as each later module ports.

## Port sources (docomply `develop` — Phase 1 artifacts and beyond)

Phase 1 wrote the canonical process docs in docomply; they are the primary
port material for the corresponding modules:

| Artifact | docomply path | Feeds module |
|----------|---------------|--------------|
| Feature-delivery pipeline (C1) | `docs/development/feature-delivery-pipeline.md` | M6, PLAYBOOK |
| PR lifecycle (C2) | `docs/development/pr-lifecycle.md` | M7, PLAYBOOK |
| PRD / research / architecture templates (C3) | `docs/development/templates/{prd,research-doc,architecture}-template.md` | M6 |
| De-scarring rule + scar lint (C4) | `docs/WIKI-SCHEMA.md` (+ lint script) | M4 |
| Miss→lens flywheel (C5) | `docs/development/ai-tools/miss-to-lens-flywheel.md` | M8 |
| HITL decision registry (C6) | `docs/development/hitl-decision-registry.md` | M0/M7 |
| Suppression-token registry (C7) | `docs/development/suppression-token-registry.md` | M1 |
| Rules-directory README (C8) | `.claude/rules/README.md` | M0 |
| Model/effort routing policy (C9) | `docs/development/ai-tools/model-routing-policy.md` | M0 |

Mechanism-level port sources (scripts, workflows, schemas) are listed per
module in each `modules/M*/README.md` § Port status.

## Decisions log (from the charter, all HITL-resolved 2026-07-18)

Private org-owned repo, separate from Forge (docomply's agent-execution
control plane — runner vs content); no license while private, Apache-2.0
recommended if opened; Phase 1 before Phase 2; newcomer accessibility is a
standing requirement (principle 7).
