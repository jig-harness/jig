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
| 3 | Port M4 docs governance, M5 ADR practice, M3 change-area catalog; add `maturity.yaml` per landed module | ✅ done 2026-07-19 (M3/M4/M5 carry the full contract — see below) |
| 4 | Port M7 review-harness core + M8 learning loop | ⬜ (next) |
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

## Phase 3 (done 2026-07-19; next work is Phase 4)

M3, M4, and M5 now carry the full module contract (`README.md`, `templates/`,
`reference/`, `mappings.md`, `maturity.yaml`), genericized and IP-scrubbed per
AGENTS.md. Each reference gate is a portable shell script with a paired
self-test and fixtures; all self-tests pass.

1. **M3 — change-area catalog.** One validated catalog → generated
   projections, referenced by name. Landed: a worked generic `catalog.yaml`, a
   language-neutral schema/resolver/projection spec, and the runnable
   regex-mirror sync guard (regex→catalog direction, with self-test). The
   resolver/emitters are specified, not transcribed — a graph job for the
   repo's own language, not bash.
2. **M4 — docs-as-wiki governance.** Landed the two M4-specific mechanical
   gates as portable, self-tested scripts: a schema-driven **frontmatter
   checker** (enum membership with did-you-mean, ADR-specific fields) and the
   C4 **de-scarring lint** (code-masked, list-anchored, with `descar_allow`
   opt-out), plus a frontmatter-aware **index generator** with a `--check`
   freshness gate (M2's triad applied to navigation). Templates: WIKI-SCHEMA
   governance model + generic frontmatter schema.
3. **M5 — ADR practice.** Landed the **numbering gate** (duplicate-number
   collision check) and a **generic `adr-rules.yaml` interpreter** for
   decisions-become-checks (deny-on-match + require-nearby, severity-aware),
   each with self-tests. Templates: ADR skeleton with amendment discipline +
   generic rules catalog. The bespoke per-rule script and the LLM "semantic"
   tier were deliberately not ported (see each README § Port status).

Deferred to their owning modules (noted in the READMEs): tag-merge normalizer
and scheduled wiki-lint (M4, future); catalog→regex reverse check needs the
resolver (M3); semantic ADR-rule tier belongs with M7/M8.

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
