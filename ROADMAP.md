# Roadmap & Status

The build-out phases come from the founding charter
([docs/founding-charter-2026-07-18.md](docs/founding-charter-2026-07-18.md),
Part V). This file is the **continuation anchor**: a session picking up
groundwork work starts here.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Founding charter (analysis, module map, blueprint) | ✅ done (vendored in `docs/`) |
| 1 | Codification **in docomply**: C1–C9 canonical docs + drift fixes | ✅ done (all 12 codification items; artifacts on docomply `develop` — see Port sources) |
| 2 | **Bootstrap groundwork**: skeleton, principles, glossary, profiles outline, auditor v0, port M0–M2 | ✅ done 2026-07-19 (all remainder items closed — see below) |
| 3 | Port M4 docs governance, M5 ADR practice, M3 change-area catalog; add `maturity.yaml` per landed module | ✅ done 2026-07-19 (M3/M4/M5 carry the full contract — see below) |
| 4 | Port M7 review-harness core + M8 learning loop | ✅ done 2026-07-20 (M7/M8 carry the full contract — see below) |
| 5 | M6/M9/M10/M11/M12, auditor v1 (scored maturity assessment; dogfood re-audit of docomply), greenfield path integrating project-kickoff | ✅ done 2026-07-20 (all five modules carry the full contract; auditor v1 scores M0–M12; greenfield folded in — see below) |
| ∞ | Backflow: evaluate each new reference-implementation lesson for porting | standing (now the active mode — all modules M0–M12 ported) |
| 6 | **Runnable tooling**: Bun/TypeScript toolchain; agent skills and dev tools moved from the reference implementation and consumed as pinned releases | kernel toolchain implemented; remaining extraction work follows § Runnable tooling |

## Phase 2 remainder (all closed 2026-07-19; next work is Phase 3)

1. ~~**M0–M2 `templates/` + `reference/` + `mappings.md` + `maturity.yaml`**~~
   — ✅ done 2026-07-19: all three modules carry the full contract,
   genericized and IP-scrubbed per AGENTS.md (see each § Port status for
   what was deliberately not ported).
2. ~~**Groundwork's own gates (dogfood M1)**~~ — ✅ done 2026-07-19:
   `bun run gates` (self-tests + link check + table check +
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
AGENTS.md. Each reference gate is a native Bun/TypeScript command with a paired
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

## Phase 4 (done 2026-07-20; next work is Phase 5)

M7 and M8 now carry the full module contract (`README.md`, `templates/`,
`reference/`, `mappings.md`, `maturity.yaml`), genericized and IP-scrubbed per
AGENTS.md. Each reference gate is a native Bun/TypeScript command with a paired
self-test and fixtures; all self-tests pass.

1. **M7 — PR lifecycle & review.** Landed the draft→review→resolve→merge
   contract as a copyable [`PR-LIFECYCLE.md`](modules/M7-pr-lifecycle-review/templates/PR-LIFECYCLE.md)
   with explicit HITL boundaries; the review-harness **config** side as
   [`review-config.yaml`](modules/M7-pr-lifecycle-review/templates/review-config.yaml)
   (tool registry, comment-only posture, numbered additive lenses, verify-tool
   invariant, containment guards, precision bar); the C6 HITL decision registry
   ([`HITL-REGISTRY.md`](modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md),
   shared with M0); and two self-tested portable gates — a **`pull_request_target`
   safety lint** (fork-unsafe reviewer wiring fails loudly) and the
   **unresolved-threads merge gate** (the address/reject/defer loop made
   mechanical). The reviewer *runtime* and docomply's 44-lens catalogue are
   deliberately not transcribed (see README § Not ported).
2. **M8 — learning loop.** Landed the miss→lens flywheel (plus the reflection
   and memory-promotion companion cycles) as [`FLYWHEEL.md`](modules/M8-learning-loop/templates/FLYWHEEL.md);
   a **generic** [`miss-taxonomy.yaml`](modules/M8-learning-loop/templates/miss-taxonomy.yaml)
   (docomply's real categories IP-scrubbed out); the eval-corpus schema
   ([`corpus.yaml`](modules/M8-learning-loop/templates/corpus.yaml)); and two
   self-tested gates — **corpus-lint** (unique lever ids, taxonomy membership,
   pinned pre-fix commit, and the **validate-then-gate** rule that a
   `required: true` fixture must carry a live-validation record) and the
   **parity report** (recall / precision / `missed_blockers`, driving the M7
   promotion bar). The eval *runner* and telemetry wiring stay with the target
   repo / M11 (see README § Not ported).

Deferred to their owning modules: the precision-bar *values* and the metric
event wiring (M11); the eval-replay runner (target-repo language, not bash).

## Phase 5 (done 2026-07-20; next work is ∞ Backflow)

The last five modules now carry the full module contract (`README.md`,
`templates/`, `reference/`, `mappings.md`, `maturity.yaml`), genericized and
IP-scrubbed per AGENTS.md. **All 13 modules (M0–M12) are ported**, so the module
map is complete and groundwork enters its standing backflow mode. Each new
reference gate is a native, self-tested Bun/TypeScript command (each
with a paired self-test; all pass); the auditor scores every module against its
criteria; and the greenfield path is folded in.

1. **M6 — feature-delivery pipeline.** Landed the idea→shipped contract
   ([`PIPELINE.md`](modules/M6-feature-delivery-pipeline/templates/PIPELINE.md):
   research spike → PRD → architecture → design-prototype loop → epic, with
   per-stage adversarial review + de-scar and the design loop allowed to feed
   back upstream); the three genericized artifact templates (PRD, architecture,
   research-note); and two self-tested gates — a **required-sections** check
   ("use the committed template" made mechanical) and a **stage-review-record**
   check (an artifact can't reach `status: accepted` without a review record).
   The kickoff seed's tiered estimates, named personas, and model-routing table
   were deliberately not ported (see README § Not ported).
2. **M9 — tasks & memory.** Landed the tracker-agnostic
   [`label-taxonomy.yaml`](modules/M9-tasks-memory/templates/label-taxonomy.yaml)
   where every **flag label** declares the process it `fires:` (folksonomy
   banned); the epic/issue templates; the what/how/in-session
   [memory tiers](modules/M9-tasks-memory/templates/MEMORY-TIERS.md) + promotion
   flow (with M8); a phase **formula** with REQUIRED phases; and two self-tested
   gates — a **label-taxonomy lint** and a **required-phases** check (a done item
   with an unrecorded required phase fails, the validate-then-gate pattern).
3. **M10 — environments & deploy.** Landed the four-stage
   [`CI-ARCHITECTURE.md`](modules/M10-environments-deploy/templates/CI-ARCHITECTURE.md)
   (PR gates → post-merge verification advancing a **verified pointer** → deploy
   of verified artifacts → manual gated promotion) with the ephemeral-env and
   test-data-factory concepts; and two self-tested gates — a **verified-pointer
   freshness watchdog** (fails when the pointer lags the default branch) and a
   **promote-safety** lint (a production deploy must be manually gated and ship
   the verified pointer, not a mutable ref). Deploy criteria are marked
   "expected-absent" for library-shaped repos.
4. **M11 — process observability.** Landed the
   [`TELEMETRY.md`](modules/M11-process-observability/templates/TELEMETRY.md)
   model (process events → metrics → dashboards → promote/demote), an
   `event-schema.yaml` and a `metrics-registry.yaml`, and two self-tested gates —
   an **event-schema lint** and a **no-dark-instruments** check (a metric whose
   `source` is `TODO`/empty fails, porting the reference implementation's
   hard-won "an instrument that's provisioned but fail-open is worse than none"
   lesson). Parity computation is referenced from M8, not duplicated.
5. **M12 — parallel-agent ergonomics.** Landed the
   [`WORKTREE-ERGONOMICS.md`](modules/M12-parallel-agent-ergonomics/templates/WORKTREE-ERGONOMICS.md)
   model plus worktree-hook and branch-discipline skeletons, and two self-tested
   **runnable utilities** — a deterministic **port allocator** (stable id→port
   via `cksum`, collision-bounded) and a cross-worktree **resource mutex**
   (atomic `mkdir` lock, PID-liveness stale reclaim, CI bypass). The mutex
   self-test proves real mutual exclusion with an enter/exit interleaving log
   plus a sensitivity guard.

**Auditor v1 (scored maturity assessment).** Every module now ships
`maturity.yaml`, so the auditor scores the whole module map against observable
criteria, not by feel. Landed [`audit/score-modules.ts`](audit/score-modules.ts)
— it emits a fill-in scoring checklist from every module's criteria, and
`--check` asserts all 13 modules carry criteria (a future port that forgets its
`maturity.yaml` fails loudly). [`audit/methodology.md`](audit/methodology.md) and
[`audit/README.md`](audit/README.md) updated to score all modules by criteria and
to map surveys→modules. The **docomply re-audit** is the operational dogfood
step; it needs read access to the private reference repo and is run where that
checkout is available — a report without file-path evidence from the real target
is not a valid audit, so it is not fabricated here (see audit/README § Dogfood
target).

**Greenfield path.** [`adoption/greenfield.md`](adoption/greenfield.md) rewritten
to fold in the project-kickoff seed: its 11 phases are mapped to modules (the
discovery outputs come from M6's templates; the phase-3 red-team pass is M6's
per-stage adversarial review in a fresh session; phase 11 populates M9's
taxonomy). The [seed](seeds/project-kickoff/) is kept as-imported for provenance,
with "the module wins" stated where they diverge.

Deferred to standing backflow: dashboard *products* and metric threshold *values*
(M11, target-repo); the preview-env spawner and test-data-factory *implementation*
(M10, host-specific); the port-allocator probe-for-free fallback (M12, noted
future). The eval/telemetry *runners* remain target-repo-language jobs, not bash.

## Standing backflow (active)

- **2026-07-24 — portfolio audit + reviewer independence.** A live
  multi-repository audit exposed two reusable gaps. First, a single-repo audit
  misses hand-copied policy drift, organization-wide enforcement gaps, and
  capabilities that need a maintained home outside an application repo. The
  auditor now includes a
  [portfolio comparison method](audit/portfolio-methodology.md), report
  template, clean-snapshot guidance, and read-only repository-host enforcement
  checks. Second, fork-safe wiring alone does not state that a PR must be
  unable to alter the reviewer code, prompts, or policy that judges it. M7 now
  carries that independent-reviewer-source invariant in its README, mapping,
  config contract, audit prompt, and maturity criteria. Groundwork's own stale
  phase summary was replaced by a pointer to this continuation anchor, and its
  CI action is now pinned to an immutable commit and has checked-in Renovate
  update policy (bot installation remains host-side). Docomply's proven
  pin-and-update discipline also exposed mutable Action references in
  Groundwork's examples; M1 now states the general invariant and the examples
  use immutable placeholders. Its Markdown gates now scan tracked and
  non-ignored untracked content, so gitignored audit snapshots and local
  workspaces cannot break repository checks.

## Runnable tooling

Groundwork takes over the generic agent skills and development tools that
grew inside the reference implementation, under the placement and porting
rules in [AGENTS.md](AGENTS.md). Background: docomply's engineering-standards
decision 0003 and its [extraction inventory](https://github.com/docomply/engineering-standards/blob/main/docs/extraction-inventory.md) classifies every unit and
orders the move:

1. **Kernel** — Bun/TypeScript toolchain, the Bash gates ported, an installer
   (pinned release → per-host cache → per-worktree skill links for both Claude
   Code and Codex), shared test helpers, and a local-checkout override for
   developing against a working tree.
2. **Pilot** — `resolve-review-comments`, plus the low-coupling skills.
3. **Issue-tracker planning cluster** — issue pickup, epic planning,
   batching, prioritisation, follow-up; the tracker interface is drawn here.
4. **Gates and workspace infrastructure** — the tooling every other step
   runs on: the change-area resolver (M3's reference implementation),
   cross-worktree locks and test infrastructure, remote gates, and the
   runnable form of M12 (Herdr workspace lifecycle and status board).
5. **PR drive loop.**

Out of scope: the reference implementation's dev dashboard. It embeds that
organization's own operating model (its tracker workflow, epics, decisions
and priorities), so it stays with that organization's tooling rather than
being abstracted here.

Each unit moves only after every import it has resolves within Groundwork
(to itself or to units already moved) and its reference-implementation
values are configuration, and the reference
implementation's copy is deleted in the same rollout. Charter amendments for
this phase are in [AGENTS.md](AGENTS.md) (toolchain; tool-bound adapters behind
interfaces; move, never copy; no issue-tracker references).

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

## Toolchain kernel

The repository and module gates now run as Bun/TypeScript. The runtime is pinned
through mise, dependencies through `bun.lock`, and the canonical `bun run gates`
command runs locally and in a Linux/macOS/Windows matrix. Existing Bash and
TypeScript fixture verdicts were compared before removing the operated shell
implementations. See [scripts/migration-parity.md](scripts/migration-parity.md)
for the comparison scope and retained shell data.

Runnable layout: [tools/README.md](tools/README.md). Non-JavaScript consumers
operate a complete pinned checkout with mise-managed Bun.

Shared test helpers have landed in `lib/`: `expectSpawnExit` and its
companions (a failed exit-code assertion carries the subprocess's output),
`guarded-git-spawn` (every spawn made through it must pass an explicit env free
of `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` or the common-dir/object-directory
routing variables, so scratch git calls cannot touch the real repository from
inside a hook; the freshness and gate test suites now use it for scratch git
commands and subprocesses that may launch git indirectly), and the per-process
temp-dir scope with its Bun preload. Not yet moved: the shell-command reachability model that
the reference implementation's workflow linter exports to many of its tests.
It is generic but sits inside a single very large file together with that
organization's workflow conventions, so it needs its own seam before it can
move.

The [installer](tools/install/README.md) now packages self-contained skill
scripts and importable shared helpers. Consumers import the helpers from
`.groundwork/lib/`; link and copy installs are checked against the release
manifest, including when no skills are selected. Consumer import switches and
local-copy deletion still require a published immutable release pin.

It records a digest/mode manifest, fetches immutable releases into an atomic
host cache, renders consumer-specific Claude Code and Codex adapters, and checks
them offline. Its local override builds working-tree snapshots. Acceptance
tests exercise concurrent Git worktrees, copy fallback, tampering and headless
installation in the native platform matrix. Consumer manifest pins, publication,
pilot skill moves, old synchronizer removal and live remote-host validation
remain the next rollout steps; no consumer has switched as part of this change.
