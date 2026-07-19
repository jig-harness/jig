---
title: "AI-Native Delivery Practices — Inventory, Gaps, and Extraction Blueprint"
type: analysis
status: draft
lifecycle: permanent
last_updated: 2026-07-19
owner: engineering
description: "Charter for reviewing docomply's SDLC/quality/docs/automation/review practices, codifying the tacit ones, and extracting them into a vendor-agnostic, stack-flexible, modular template repo for greenfield and brownfield projects."
tags: [analysis, knowledge-management, workflow, ci-cd, plan, architecture]
related:
  - /AGENTS.md
  - /docs/WIKI-SCHEMA.md
  - /docs/development/change-areas-design.md
  - /docs/development/ai-tools/code-review-cost-analysis.md
  - /docs/development/planning-templates.md
---

> **Vendored copy** — imported 2026-07-19 from `docomply/docomply` `develop`
> (`docs/research/ai-native-delivery-practices-extraction-2026-07-18.md`) as groundwork's
> founding charter. The docomply copy is the living original until groundwork Phase 3;
> repo-relative links inside it resolve in the docomply repo, not here.


# AI-Native Delivery Practices — Inventory, Gaps, and Extraction Blueprint

This document is the **charter and working map** for a three-goal initiative:

1. **Review** docomply's delivery practices (SDLC, quality, maintainability, documentation, automation, observability, process visibility) and recommend improvements.
2. **Codify** the practices that are practiced-but-unwritten.
3. **Extract** the generalizable techniques into a new standalone repo — a vendor-agnostic, tech-stack-flexible, modular template/reference for kickstarting greenfield projects and upgrading brownfield ones, with **AI-agent scaffolding as the unifying spine**. The repo must also work as an **audit tool**: pointed at a target (brownfield) repo, it produces an analysis report with actionable, prioritized recommendations (see Part IV, "The auditor").

It was produced by a full-repo survey (2026-07-18) of four surfaces: the `.claude/` agent scaffolding, the `docs/` wiki governance system, the automation/enforcement machinery, and the review architecture + learning loop. It is written so a future session can pick up any phase of Part V without re-deriving the analysis.

**Positioning against adjacent initiatives** (both must be read before starting Part V work):

- **`project-kickoff` skill** (v2.0, 2026-02; **stable copy: `docomply/jig` repo, `seeds/project-kickoff/`** — vendored there 2026-07-18 from its origin as a personal Craft Agents skill so the reference resolves for any session or contributor; Phase 2/5 folds it into `adoption/greenfield.md`): an 11-phase greenfield bootstrap methodology (requirements → architecture → red-team → synthesis → repo bootstrap → planning → tracking) with Lite/Standard/Enterprise tiers, PRD/architecture templates, and context-isolation discipline for adversarial review. It ends where a project *starts*. The extraction repo **subsumes it as the greenfield adoption path** and adds everything docomply evolved afterwards: the operating system for *ongoing* delivery.
- **Forge** (the `forge` repo; ADR-0072/-0073/-0074/-0078; repo-side config at `.forge/config.yaml`): an agent-execution **control plane** — it runs coding agents against repos, resolving execution config as `base ⊕ repo-overlay ⊕ floor`, deriving stack facts from the worktree (lockfile → package manager, `turbo.json` → runner, workflows dir → CI provider), and enforcing a gate floor that repos can only strengthen. Forge is the *runner*; the extraction repo is the *practices a repo carries* so that any agent — Forge-driven or interactive — can operate it well. They are complementary: template-conformant repos need thinner Forge overlays, and Forge's derive-don't-declare approach is the model for the template's tool-agnosticism.

---

## Part I — Practice inventory: the docomply "delivery operating system"

Twelve pillars, each with its concrete implementation and the abstract, extractable pattern behind it.

### 1. Instruction architecture

`AGENTS.md` (universal SSoT, 323 lines, vendor-neutral) + `CLAUDE.md` (tool-specific, points rather than duplicates) + nested per-directory `AGENTS.md` ("closest file wins") + `.claude/rules/` (16 conditional rules loaded by `paths:` frontmatter globs) + `CONTEXT.md` (one-screen domain glossary with canonical terms and **Avoid** aliases, auto-loaded via a rule). Behavioral dispositions are codified as first-class sections: *Default Disposition — Disciplined, Systematic, Methodical* (invoke gates, mechanize checks, fix root causes, treat bugs as classes), *BWC — Currently Deferred* (pre-GA: no compat shims, with an explicit flip condition), and the minimalism decision ladder rule.

**Extractable patterns**: layered instruction files with an explicit SSoT and pointer discipline; conditional path-scoped rules; a project glossary as drift prevention for parallel agents; dispositions (including lifecycle-stage-dependent ones like BWC) written down with flip conditions.

### 2. Skills, agents, and cross-tool interop

120 skills under `.claude/skills/` (canonical), mirrored to `.agents/skills/` as gitignored symlinks regenerated on `pnpm install` (`tools/ai/sync-agent-skill-symlinks.sh`, `--check` on pre-push) so Codex and other runtimes discover the same content. A 28-agent roster in three cost tiers (Opus-strategic ≈5%, Sonnet-execution ≈30%, Haiku-scouts ≈65%, per `.claude/agents/HAIKU-WORKERS.md`). Skills follow progressive disclosure with an enforced size ladder.

**Extractable patterns**: skills as the unit of codified procedure; the symlink interop mechanism (single source, multi-runtime discovery, mandatory-skill presence check); the tiered agent roster with explicit cost economics; scout-before-implement (`/pre-flight`).

### 3. Quality gates and the enforcement ladder

Five root gates (`format`, `lint:quiet`, `check-types`, `test:quiet`, `build`) stated identically in `AGENTS.md` (SSoT) and `CLAUDE.md`. Below them, a graduated enforcement ladder: editor/local script → lefthook pre-commit (auto-fix-and-stage where possible) → pre-push (~20 grep gates + heavy build-and-test behind a cross-worktree mutex) → CI (`pr-quality-gates.yml` as authority, closing the `--no-verify` hole) → mandatory review skills → convention. ~40 `scripts/check-*` grep gates each carry a paired self-test and fixtures. A commit-msg gate (`[skill:db-migration-reviewed]`) mechanically backstops a human/Opus review requirement.

**Extractable patterns**: the enforcement-ladder concept itself (every convention names its rung and its promotion path); the grep-gate framework with self-tests; local-hook/CI-authority duplication; auto-fix-and-stage twins; the review-marker commit-msg gate; `tools/dev/with-resource-lock.sh` (portable cross-worktree mkdir mutex with PID-liveness, stale reclaim, CI bypass).

### 4. Generated artifacts with freshness gates

The single most repeated pattern (~16 instances): any committed generated file gets (a) a regenerate script, (b) a `--check` drift gate in CI, (c) a pre-commit auto-regenerate-and-stage twin. Instances: DB reference schema + Drizzle types (via **ephemeral-container migration replay** with symmetric cleaning — the strict, load-bearing variant), OpenAPI + generated TS types, error-code registry + docs, `docs/INDEX.md`, review-gate table + component directory + `.forge/areas.yaml`, scenario seeds, Keycloak realm, cdk8s manifests, license NOTICE.

**Extractable pattern**: the generate → drift-check → auto-stage triad, plus ephemeral-replay drift checking for schema-like artifacts.

### 5. Change-area catalog (SSoT with projections)

`tools/change-areas/catalog.yaml`: 32 areas mapping path globs → implications, with a validated schema, directed `impliedBy` fan-in closure, and thin per-consumer projections: CI gate selection (mechanical — the verify pipeline resolves areas to decide what to verify), deploy tiers, mandatory review skills (generated gate table), Linear labels, post-deploy actions. A hand-maintained CI regex shortcut is mechanically checked against the catalog (`check-detect-changes-catalog-sync.sh`) — the "regex mirror kept honest" pattern.

**Extractable pattern**: one change-vocabulary SSoT, many generated projections; consumers never re-hardcode globs.

### 6. Docs-as-LLM-wiki governance

`docs/WIKI-SCHEMA.md` codifies a three-layer model (raw sources → compiled wiki → navigation/meta), an 11-type/6-status/3-lifecycle frontmatter schema machine-validated against `docs/.frontmatter-schema.yaml` (lefthook + blocking CI), a ~50-tag canonical taxonomy with merge map, auto-generated `docs/INDEX.md` (blocking freshness gate), `docs/log.md` tagged activity journal, `docs/connections/` cross-domain pages, `docs/retrospection/` as the promotion target for agent memory, and an authority hierarchy for conflicts (schema > openapi > ADRs > entity docs > feature docs > retrospection).

**Extractable patterns**: the whole governance kit is nearly turnkey — schema file, checker script, index generator, CI workflows are cleanly parameterized on `docs/**`. The taxonomy content is project-specific; the mechanism is not.

### 7. ADR practice

79 sequential ADRs with enforced frontmatter (`decision_date`, `supersedes`, `superseded_by`), a duplicate-number lefthook gate (born from a real collision incident), formal evolution via `## Amendments` + `status: amended`, and — notably — **ADR-to-code-rule extraction**: `.claude/scripts/adr-tier1-check.sh` pattern-matches staged code against `.claude/adr-rules/rules.yaml`, turning selected ADR decisions into mechanical gates.

**Extractable patterns**: ADR numbering gate; amendments discipline; the tier-1 "decisions become greps" extraction pipeline.

### 8. Review architecture (multi-reviewer, layered)

Four concurrent reviewers with distinct roles: the **internal shadow reviewer** (`tools/ai/pr-review.ts`, 44 numbered lenses, COMMENT-only posture, `pull_request_target` with base-branch code extraction for security), **CodeRabbit** (retained for AST/semgrep depth), **Codex**, and humans. Mandatory review *skills* are selected per change-area (generated gate table); `/review` orchestrates local tiered review (Haiku patterns → Sonnet contracts → Opus semantics); `resolve-review-comments` codifies the address/reject/defer + GraphQL-resolve loop with HITL rules for scope expansion and human threads. The reviewer is split into a repo-agnostic core (tool registry, verify-tool invariant, containment guards) and a config consumer (`review-config.yaml` + plugins) — already extracted cross-repo once (forge/website, L16).

**Extractable patterns**: shadow-reviewer-as-harness (additive prompt lenses, not a static analyzer); the core/config split; COMMENT-only-until-proven posture with a pre-committed precision bar for ever flipping to blocking; the comment-resolution loop contract.

### 9. The learning loop (the flywheel)

Three interlocking cycles:

- **Miss → lens**: external oracle catches what the shadow reviewer missed → classify against the shadow-reviewer miss taxonomy (canonical home: the **an issue** epic comment thread, *developed via* the PR #3526 / an issue parity retrospective — an issue is the analyzed PR's issue, not the taxonomy's home) → Linear issue with a durable L-number → reconstruct as an eval fixture pinning the *pre-fix* commit (`required:false` until a live run validates) → add an additive lens/checklist bullet → promote the fixture to the regression gate → measure recall/precision/cost marginally (PostHog + weekly parity report vs vendors, with a `missed_blockers` gate metric driving a vendor-cancellation decision). **Now codified as a named process doc: [`docs/development/ai-tools/miss-to-lens-flywheel.md`](/docs/development/ai-tools/miss-to-lens-flywheel.md) (C5, an issue).**
- **Session reflection**: `/reflect` accumulates session feedback into an inbox → `/review-reflection-feedback` processes it with **mandatory human approval** into meta-spec changes → weekly review summaries in `docs/retrospection/reviews/`.
- **Memory promotion**: agent-private memory → `/promote-memory` → git-tracked `docs/retrospection/` → wiki compilation.

**Extractable patterns**: all three cycles are mechanism, not content. The miss→lens flywheel (*oracle → taxonomy → numbered lever → pre-fix fixture → additive module → validate-then-gate → measure*) is the most distinctive and transferable practice in the whole system — it applies to any evaluable agent behavior, not just review.

### 10. Task and memory systems

Three-tier division of labor: **Linear** = *what* (team-visible units, 1–8h) with a mandatory label taxonomy where flag labels *drive process* (`has-migration` → migration gate, `api-change` → API gates, `dpa-relevant` → compliance register update, `manual-ops` → operator checklist blocks Done, `hitl` → revokes autonomous execution); **Beads** = *how* (5–30min phases, git-backed, cross-session, with pre-built formulas encoding required phases like architect-review and staging-verify); **CC tasks** = in-session. Epic/issue templates in `docs/development/planning-templates.md`.

**Extractable patterns**: tracker-agnostic issue taxonomy where labels are process triggers, not folksonomy; phase formulas with REQUIRED gates; the what/how/in-session tiering.

### 11. Environments, deployment, and process observability

Four-workflow CI/CD architecture (PR gates → verify-develop advancing a `verified` pointer with a self-healing freshness watchdog → deploy verified artifacts → manual promotion), ephemeral preview environments (`/spawn-env`), test-data factory with multi-org isolation (TDF/DSF), and **observability of the dev process itself**: per-review telemetry events, weekly vendor-parity snapshots, `/reflect --comprehensive` velocity/hotspot signals. Known gap: no gate-pass-rate dashboard (see Part II).

**Extractable patterns**: verify-then-promote with a pointer branch; ephemeral env + seeded test-data concepts; process telemetry as a first-class concern.

### 12. Parallel-agent ergonomics

Worktree-create hooks allocating deterministic port slots; the cross-worktree heavy-test mutex; branch-reuse-before-create discipline; bans with rationale (no `git stash` across shared worktrees, no `bun install` at root); a worktree-remove hook nudging `/reflect`.

**Extractable pattern**: treat "N agents in parallel on one machine/repo" as a designed-for condition with explicit resource isolation.

---

## Part II — Gap analysis and improvement recommendations (docomply-facing)

Ordered by leverage. Items marked **[codify]** overlap with Part III; items marked **[template]** double as extraction prerequisites.

### P1 — high value, low-to-medium effort

1. **Codify the feature-delivery pipeline** **[codify][template]**. The full flow (exploration/research → PRD → architecture → Claude-Design prototype loop → prototype import → architecture re-examination → epic/issue creation) is practiced and partially tooled (`docs/research/` dated spikes, ~15 PRDs, `claude-design-workflow.md`, `/claude-design-import`, `/design-import-epic`, `planning-templates.md`) but **no canonical process doc exists**. Write `docs/development/feature-delivery-pipeline.md` as the narrative contract, referencing skills as the executable steps. Include the per-stage adversarial-review + de-scar loop (see item 5).
2. **Codify the PR lifecycle loop** **[codify][template]**. Same situation: draft PR → shadow+external review → resolve-comments loops → gates → conflict resolution → human Ready/merge → Linear update exists as skills (`resolve-review-comments`, `/fix-ci`) plus a *draft* `WORKFLOW.md` sketch, but no end-to-end narrative. Write it; retire or finish the draft sketch.
3. **Fix the observed drift** (all confirmed this session):
   - `docs/DEVELOPMENT-WORKFLOW.md` still documents Next.js dev servers (frontends are Vite SPAs) and is dated 2026-02-24.
   - `docs/QUALITY-STANDARDS.md` §4 ("SDK Regeneration") still mandates `cd packages/docomply-sdk && pnpm run generate` — a package that no longer exists in the repo (it was the legacy Orval-generated SDK; note the doc itself never uses the name "Orval"). Eden Treaty replaced it.
   - `AGENTS.md` says frontends deploy to Cloudflare Pages; `.claude/rules/frontend-rendering.md` and the skills README say Bunny CDN. AGENTS.md is stale — a real contradiction an agent can act on.
   - `AGENTS.md` § Documentation Lookup references `apps/forge-control-plane/` and `docs/development/software-factory/**`, which exist in no tree (Forge lives in its own repo).
   - `.claude/skills/README.md` self-reports 110/103 skills; 120 exist.
   - `docs/retrospection/README.md` references a nonexistent `docs/reflection/` path; nvm vs fnm references are mixed across `.mcp.json` / settings / setup docs; model-version strings differ across agent index and CLAUDE.md.
4. **Give prose facts freshness gates** **[template]**. The drift above is exactly the class the generated-artifact triad prevents. Two cheap mechanisms: (a) machine-generate countable facts (skill counts, agent rosters, model assignments) into `_generated/` includes; (b) a CI-advisory "referenced-path exists" check over `AGENTS.md`/`CLAUDE.md`/skills README (the Doc Link Checker agent already has the logic; make it a script + workflow).
5. **Make de-scarring an explicit rule** **[codify][template]**. The practice (final artifacts cleaned of review findings/corrections; findings parked in companion files, Linear, or git history; light version-history section allowed) is culturally strong but unwritten. Add it to `WIKI-SCHEMA.md` as a promotion criterion: a doc cannot move to `status: approved` carrying review scars. Add a `docs-lint` check for scar markers (review-comment blocks, "addressed", strikethroughs, reviewer names in body text).
6. **Wire or delete `verify-before-complete.sh`** — **Resolved (an issue): deleted.** The exit-coded script was unwireable as a Stop hook (Claude Code Stop hooks only block on exit `2`, so its `exit 1/2/3` design would silently not block on test/lint failures; it also fires on every conversational turn, making heavy gates far too slow). Enforcement already lives in the pre-push `build-and-test` lefthook + CI; the Stop hook stays an intentional lightweight reminder. The script was removed and its only manual-run reference (`verify-completion` skill) repointed to the canonical chained gate command `pnpm check-types && pnpm lint:quiet && pnpm test:quiet` (chained so exit codes propagate — not `verify:parallel`, whose `& … & wait` form returns exit 0 even when a background check fails).

### P2 — medium

7. **Promote settled advisory gates to blocking**: `change-areas:lint` (intentionally `exit 0` today), Eden SDK coverage, oxlint, error-code audit. Each needs only a baseline-cleanup pass first.
8. **Mechanize i18n key coverage**. Placeholder syntax is gated; missing/redundant key detection lives only in the `/i18n-scout` skill. Extract its core into a script + CI advisory gate, then promote.
9. **App-layer multi-tenant gate**. Tenant isolation is mechanically enforced only at infra edges (Valkey/storage/outbox/DEK); the core "every query carries `organization_id`" is skill-audited. Investigate a lint-level check (Drizzle query-builder call sites without `withTenantIsolation`/org predicate) — even a high-recall/medium-precision advisory gate beats convention.
10. **Finish the review-measurement provisioning**. Several instruments are silently dark (fail-open): `POSTHOG_API_KEY`, `REF_API_KEY` (doc-grounding lens never advertised), `OPENAI_API_KEY` (B arm), GitHub App identity. The `actedOn` (adoption-rate) metric is a TODO; the eval corpus has exactly one `required:true` fixture — run the validation passes to harden the regression gate. Without these, the flywheel's *measure* step is partly aspirational.
11. **Suppression-token registry** **[codify]**. `audit-ignore`, `tenant-audit-exception:`, `storage-tenant-exception:`, `content-policy-allow:`, `BACKOFFICE:` etc. are each defined inline in their own rule. One reference page: token → gate it suppresses → justification requirements.
12. **`.claude/rules/README.md`** **[codify]**. Document the `paths:` frontmatter mechanism and the "no frontmatter = always loaded" behavior, currently only inferable.
13. **Permission-allowlist hygiene**: `settings.local.json` carries ~95 entries including stale one-off literals; run `/fewer-permission-prompts` style consolidation.

### P3 — structural

14. **Process-observability dashboard**: gate pass rates, CI duration trends, review-adoption rate, reviewer cost — the events partially exist; the dashboard and gate-pass-rate telemetry don't.
15. **Automate the wiki lint cadence**: the 7-check lint table in WIKI-SCHEMA (stale >6mo, broken links, contradictions, retrospection backlog) is manual; a scheduled workflow posting a report would close it. Connections pages are lightly populated (4 built) — fold "connection candidates" into the same report.
16. **HITL decision registry** **[codify]**: the human-checkpoint set (mark PR Ready, merge, prod promote, dark-dial flips, meta-spec changes, destructive ops, scope expansions) is consistently practiced but scattered across L10, the `hitl` label, draft-PR rules, and skill bodies. One page listing every decision class that must stay human, and why.

---

## Part III — Codification backlog (tacit → canonical)

Consolidated from Part II, in suggested authoring order. Each doubles as extraction source material — **author in docomply first, then port**.

| # | Artifact | Seeds that exist today |
|---|----------|------------------------|
| C1 | `docs/development/feature-delivery-pipeline.md` — exploration → research → PRD → architecture → design-prototype loop → import → epic/issues, with per-stage adversarial review + de-scar | `claude-design-workflow.md`, `planning-templates.md`, `docs/research/` conventions, retention-management 00–10 plan set (worked example) |
| C2 | `docs/development/pr-lifecycle.md` — draft PR → multi-reviewer → resolve loops → gates → merge → Linear update, incl. HITL boundaries | `resolve-review-comments` skill, branch-strategy.md, ci-gates.md, draft `ai-tools/WORKFLOW.md` |
| C3 | PRD template + research-doc template + architecture template (as files, not copy-from-neighbor) | project-kickoff `references/template-prd.md` + `template-architecture-core.md`; existing PRDs |
| C4 | De-scarring rule in `WIKI-SCHEMA.md` + lint check | log.md cleanup campaigns; companion-file convention |
| C5 | The miss→lens flywheel as a named process doc **✅ [`docs/development/ai-tools/miss-to-lens-flywheel.md`](/docs/development/ai-tools/miss-to-lens-flywheel.md) (an issue)** | `code-review-cost-analysis.md` §7, corpus.yaml header, miss-taxonomy analysis (canonical home: the **an issue** epic comment thread, developed via the PR #3526 / an issue retrospective — corrected in an issue) |
| C6 | HITL decision registry | L10 posture doc, `hitl` label definition, skill HITL clauses |
| C7 | Suppression-token registry | inline definitions across rules |
| C8 | `.claude/rules/README.md` | the 16 rule files |
| C9 | Model/effort routing policy (one page; generated where countable) | HAIKU-WORKERS.md, agents README, ADR-0074 |

---

## Part IV — Extraction blueprint: the template repo

### Working name

**`groundwork`** (working title — alternatives: `delivery-os`, `ai-native-sdlc`). Standalone repo, private initially. Not part of Forge (Forge *consumes* well-scaffolded repos; this repo *defines* the scaffolding), not a skill (it's a body of modules + reference implementations, though it should *ship* skills).

### Design principles

1. **Principles over tools.** Every module states the invariant ("committed generated artifacts carry a drift gate"), then maps reference implementations per ecosystem: Claude Code/Codex/Cursor; Linear/Jira/Dart; lefthook/husky/pre-commit; GitHub Actions/GitLab CI; CodeRabbit/Greptile/shadow-harness. Derive-don't-declare where possible (Forge's stack-fact derivation is the model).
2. **Modular, profile-composed.** Modules adopt independently; three profiles compose them: **Solo/Lite** (short-lived, one person), **Team/Standard** (production, multiple contributors), **Regulated/Strict** (compliance posture). Maps to project-kickoff's tiers; each module defines its own Lite/Standard/Strict maturity levels so brownfield projects can adopt one rung at a time.
3. **AI scaffolding as the spine.** Every module is written to be *operable by agents*: machine-checkable rules, SSoT + generated projections, explicit enforcement rungs, glossaries against parallel-agent drift. This is the unifying principle — the other modules feed it and benefit from it.
4. **Enforcement ladder discipline.** Every convention names its current rung (doc → hook → CI → review gate) and its promotion path. "Convention-only" is a tracked state, not a resting place.
5. **Learning loop built in.** The template ships the flywheel (reflection, memory promotion, miss→lens for any evaluable agent behavior), and the template repo itself runs one: docomply is instance #1, and lessons flow back.
6. **Audit-first brownfield entry.** The repo is not just reference material — it is a runnable assessor. Every module ships machine-evaluable maturity criteria, so an agent can audit a target repo against the full module map and emit a scored report with actionable recommendations.
7. **Accessible to newcomers.** Groundwork assumes no prior familiarity with any of these techniques. A root `GLOSSARY.md` defines every term of art in plain language (SSoT, enforcement ladder, drift/freshness gate, HITL, ADR, scaffolding, grep gate, flywheel, worktree, monorepo, …); module docs expand jargon on first use and link to the glossary; every module README opens with a plain-language "what problem this solves and what it looks like without it" paragraph before any mechanism detail.

### The auditor (brownfield audit capability)

The natural brownfield entry point is not "adopt module M0" — it is **"tell me where I stand."** The auditor is an agent-runnable harness (a skill plus survey prompts, no bespoke infrastructure) that:

1. **Fans out parallel read-only surveys** over the target repo, one per practice area — instruction files, docs governance, automation/enforcement, review setup, task/memory systems, environments/CI. This session's four-survey sweep of docomply *is* the prototype run; its survey prompts should be preserved in the audit harness as seeds.
2. **Detects the existing stack** (derive-don't-declare: lockfiles, hook configs, CI provider, tracker references) so recommendations are phrased in the target's own tools, not the template's defaults.
3. **Scores each module** against its Lite/Standard/Strict maturity criteria, distinguishing *absent* / *convention-only* / *mechanically enforced* — the enforcement-ladder rung is the score.
4. **Emits a report**: per-module findings with evidence (file paths), a prioritized recommendation list (leverage × effort, mirroring Part II's shape), a suggested adoption sequence, and drift/staleness findings (the audit also catches contradictions between a repo's stated and actual practices, as this session's audit did for docomply).

Deliverables in the repo: `audit/methodology.md`, `audit/survey-prompts/` (one per area), `audit/report-template.md`, and per-module `maturity.yaml` criteria the scorer reads. Dogfooding target: re-run the auditor on docomply periodically — it doubles as a practices-drift regression check (the Part II drift list is exactly what a scheduled audit would have caught earlier).

### Module map (numbered for roadmap reference)

| Module | Content | Primary docomply sources |
|--------|---------|--------------------------|
| M0 Instruction architecture | AGENTS.md skeleton, nested files, conditional path-rules, glossary, dispositions (incl. BWC-with-flip-condition, minimalism ladder) | AGENTS.md, `.claude/rules/`, CONTEXT.md |
| M1 Gates & enforcement ladder | Gate set, hook configs, grep-gate framework with self-tests, CI-authority pattern, review-marker gates, resource mutex | `lefthook.yml`, `scripts/check-*` + `test-*`, `tools/dev/with-resource-lock.sh` |
| M2 Generated-artifact freshness | The triad pattern + ephemeral-replay drift harness | `tools/db/*`, `tools/docs/generate-index.ts`, workflows |
| M3 Change-area catalog | Schema, validator, resolver, projection emitters, regex-mirror guard | `tools/change-areas/*`, `check-detect-changes-catalog-sync.sh` |
| M4 Docs-as-wiki | WIKI-SCHEMA, frontmatter schema + checker, index generator, log/connections/retrospection conventions, de-scarring rule | `docs/WIKI-SCHEMA.md`, `docs/.frontmatter-schema.yaml`, `.claude/scripts/frontmatter-check.sh`, docs workflows |
| M5 ADR practice | Template, numbering gate, amendments, decisions-become-greps extraction | `docs/adr/`, `tools/check-adr-numbers.sh`, `adr-tier1-check.sh` |
| M6 Feature-delivery pipeline | C1 + C3 templates + design-prototype loop + epic decomposition, per-stage adversarial review | C1/C3 (Part III), project-kickoff phases 1–4, 10–11 |
| M7 PR lifecycle & review | C2, draft-PR discipline, multi-reviewer layering, shadow-harness core (tool registry, verify-tool invariant, `pull_request_target` security pattern, config schema), resolve-comments loop | `tools/ai/review/`, `review-config.yaml` schema, `resolve-review-comments` |
| M8 Learning loop | C5 flywheel, reflect/feedback-inbox/promote-memory cycles, eval-corpus + parity-tracker shapes | `tools/ai/eval/`, `tools/ai/parity/`, reflect commands |
| M9 Tasks & memory | Tracker-agnostic taxonomy with process-driving flag labels, phase formulas, what/how/in-session tiering | Linear label taxonomy, beads formulas, planning-templates |
| M10 Environments & deploy | Four-workflow architecture, verified-pointer + watchdog, ephemeral envs, test-data factory concept | `.github/workflows/` spines |
| M11 Process observability | Review/gate telemetry, parity reporting, dashboards | PostHog events, parity tracker |
| M12 Parallel-agent ergonomics | Worktree ports, mutex, branch discipline, interop symlinks | worktree hooks, sync script |

### Repo structure sketch

```
groundwork/
  README.md              # what/why, profile chooser, adoption paths
  GLOSSARY.md            # plain-language definitions of every term of art
  PLAYBOOK.md            # end-to-end narrative: delivery pipeline + PR loop
  principles/            # one doc per design principle
  modules/M<no>-<name>/
    README.md            # invariant, maturity levels (Lite/Standard/Strict), adoption steps
    templates/           # copyable skeletons (AGENTS.md, PRD, ADR, WIKI-SCHEMA, …)
    reference/           # portable code: scripts, workflow YAML, schema files
    mappings.md          # per-ecosystem tool mapping table
  profiles/              # solo-lite.md, team-standard.md, regulated-strict.md
  audit/                 # the auditor: methodology.md, survey-prompts/, report-template.md
  adoption/
    greenfield.md        # integrates project-kickoff's 11 phases
    brownfield.md        # audit-driven entry + module-by-module ladder
  examples/              # trimmed, scrubbed docomply-derived instances
```

### Extraction cautions

- **IP scrub**: strip docomply domain content and anything adjacent to `docs/legal/invention-disclosure-ai-scenario-pipeline.md` (matching, interpolation, tier names). The help-center content policy's forbidden-terms list is a useful scrub checklist.
- **Values vs mechanisms**: every ported file must be split the way the reviewer already is (repo-agnostic core, project config). Where docomply hasn't made that split (e.g., grep gates with hardcoded paths), make it during porting.
- **Don't port what's unproven**: dark dials, `required:false` fixtures, and aspirational hooks stay out until validated in docomply.

---

## Part V — Roadmap (phased, resumable)

| Phase | Scope | Depends on |
|-------|-------|------------|
| 0 | **This charter** (done, this doc) | — |
| 1 | Docomply codification + drift fixes: C1–C9 (Part III) plus P1 items 3, 4, and 6 — P1 item 5 *is* C4, so the scope is 12 distinct items. **Filed: epic an issue, sub-issues an issue–an issue (12)** | 0 |
| 2 | Repo bootstrap: skeleton, principles, profiles outline, `GLOSSARY.md` v0; **auditor v0** (methodology + survey prompts distilled from this session + report template); port M0–M2 (highest leverage, least entangled) | 0 (1 helpful) |
| 3 | Port M4 docs system, M5 ADR practice, M3 change-area catalog; add per-module `maturity.yaml` criteria as modules land | 2 |
| 4 | Port M7 review harness core + M8 learning loop (build on the existing core/config split; the cross-repo extraction was already done once for forge/website) | 2, and P2 item 10 for credibility |
| 5 | M6/M9/M10/M11/M12, auditor v1 (scored maturity assessment; dogfood re-audit of docomply), greenfield path integrating project-kickoff | 1, 3 |
| ∞ | Ongoing: docomply-to-template backflow (each new lens/gate/pattern evaluated for porting) | 4 |

### Decisions (2026-07-18, HITL — resolved)

1. **Name**: `groundwork` (adopted).
2. **Repo location/visibility**: standalone private repo `docomply/jig`, org-owned. Publishing to be reconsidered later; per-module publishing (e.g., M1/M2/M4 first) remains an option that limits competitive-advantage exposure while capturing reputation/feedback benefits. Regardless of the visibility decision, the IP scrub (Part IV cautions) applies from day one so the option stays open.
3. **Relationship to Forge**: strictly separate. Forge = runner, groundwork = practices content; Forge's repo-overlay (and docomply itself) may later *reference* groundwork modules.
4. **License**: none while private (all rights reserved by default). If/when opened: **Apache-2.0** (patent grant, corporate-adoption-friendly, works for prose + code alike). Copyleft/BUSL-style protection was considered disproportionate for a practices playbook.
5. **Ordering**: Phase 1 first — codifying in docomply exercises the material against a real project before abstracting it.
6. **Accessibility requirement** (added 2026-07-18): groundwork must be usable by people unfamiliar with any of these techniques — see design principle 7 (glossary, first-use jargon expansion, plain-language module openers).

---

## Appendix — Survey provenance

Produced 2026-07-18 in Conductor workspace `chicago-v6` (branch `feature/sdlc-practices-template-repo`) via four parallel repo surveys (scaffolding surfaces; docs governance; automation/enforcement; review architecture + learning loop) plus direct reads of `AGENTS.md`, `CLAUDE.md`, `docs/QUALITY-STANDARDS.md`, `docs/DEVELOPMENT-WORKFLOW.md`, `docs/.frontmatter-schema.yaml`, `.forge/config.yaml` (origin/develop), and the `project-kickoff` skill. Factual claims about file contents reflect that date; re-verify counts before relying on them (they drift — which is itself finding P1-4).
