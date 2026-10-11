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
| 6 | **Runnable tooling**: Bun/TypeScript toolchain; agent skills and dev tools moved from the reference implementation and shipped as the `groundwork` plugin for Claude Code and Codex | kernel toolchain, plugin distribution and the PR drive loop move landed (plugin 0.3.0); next moves follow § Skill moves after the drive loop |

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

1. **Kernel** — Bun/TypeScript toolchain, the Bash gates ported, shared test
   helpers, and skill distribution: this repository is a plugin that Claude
   Code and Codex install once per machine
   ([plugin/README.md](plugin/README.md)).
2. **Pilot** — `resolve-review-comments`, plus the low-coupling skills
   (chosen in [Skill moves after the drive loop](#skill-moves-after-the-drive-loop)).
3. **Issue-tracker planning cluster** — epic planning, batching and
   prioritisation, each re-evaluated before it moves: they would reuse the
   [tracker interface](GLOSSARY.md) that `do-item` brought with the PR drive
   loop move (step 5), but much of their content is the organization's own
   tracker workflow. Follow-up, the debt report, epic acceptance review and
   the label tooling stay with the reference implementation.
4. **Gates and workspace infrastructure** — the tooling every other step
   runs on: the change-area resolver (M3's reference implementation),
   cross-worktree locks and test infrastructure, remote gates, and the
   runnable form of M12 (Herdr workspace lifecycle). Its status board stays
   with the reference implementation for now and calls the plugin's scripts.
5. **PR drive loop** — moves as one unit with the issue-pickup skill that
   starts it and the Review Arbiter agent; see
   [PR drive loop move](#pr-drive-loop-move). Landed with plugin 0.3.0,
   ahead of steps 3 and 4.

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

Skills ship as the `groundwork` plugin: [plugin/](plugin/) carries a Claude Code
and a Codex plugin manifest, this repository a marketplace for each tool, and each machine installs it once
([plugin/README.md](plugin/README.md)). Each consumer repository commits only
its values, in `.config/groundwork-overlay.yaml`, which the skills read at run
time. This replaced a per-worktree installer (pinned release, host cache,
rendered adapters, links, a bootstrap run from install hooks and a git hook):
the agent tools list skills when a session starts, so per-worktree installs
needed a setup step in every place a worktree is created, while a per-machine
plugin is visible everywhere. Releases up to `v0.1.1-review-pilot` remain
tagged for repositories that have not migrated.

## Review-skill pilot preparation

The operated TypeScript [review-resolution skill](plugin/skills/resolve-review-comments/README.md)
and its suite now live here and ship in the plugin. Consumer policy is read at
run time from the consumer repository's configuration, and optional sibling
skills resolve in the consumer repository. Groundwork runs the moved behavioral
suite and a plugin test that runs the scripts from outside this repository;
consumer-side tests retain the real driver integration. Both harnesses were
exercised against a live pull request through the installed plugin. Consumer
migration from the per-worktree installer follows
[the migration steps](plugin/README.md#migrating-from-the-per-worktree-installer).

## PR drive loop move

The [PR drive loop](GLOSSARY.md) was the reference implementation's skill that
wraps the
[review-resolution skill](plugin/skills/resolve-review-comments/README.md) for
unattended work on one pull request; it now ships in the plugin as `drive-pr`.
The review skill repeats rounds until the reviewers settle; the drive loop adds
what only it provides: a lease
that fences the working tree so two agent sessions never answer the same
thread, labels for findings the pull request's own earlier commits caused,
checks for findings that appear only in a reviewer's summary, and round state
that survives between invocations.

Before this move, the review skill already shipped in the plugin and five
consumer repositories used it from there, but the reference implementation
did not: its own drive-loop skill and the review skill imported and ran each
other's code, and its status board and other skills called the review skill's
scripts by repository path. Splitting that set across the plugin boundary
needed a lookup seam in every caller and a Groundwork checkout in its CI, and
each further skill moved alone would need another. The set therefore moved
together, in these steps:

1. **Inventory** the coupled set in the reference implementation: the
   drive-loop skill, the review skill, and every skill or tool that imports
   from or spawns either (at least the status board, the debt report and the
   issue-pickup skill), with their tests. The issue-pickup skill starts a
   drive once it opens a pull request, and the drive loop imports its handoff
   code, so it belongs to the set. Inside the set that handoff code may move
   to whichever skill owns it; the move need not cut the link first. The
   issue-pickup skill ships here as `do-issue` (since renamed `do-item`),
   named for the mechanism rather
   than a tracker: it reaches the tracker only through the interface drawn in
   step 3 of [Runnable tooling](#runnable-tooling), and the organization's
   tracker values arrive as configuration.
2. **Split** each unit into the generic mechanism and the organization's
   values, which become fields of `.config/groundwork-overlay.yaml`, as the
   review skill's were.
3. **Move** the set into `plugin/skills/` in one change. Siblings then sit
   beside each other in the plugin, so the existing sibling lookup applies
   and no repository-path seam remains.
4. **Retire** the reference implementation's copies in the same rollout and
   switch its instructions to the plugin's commands. Installing a plugin does
   not enable it in a repository, so the same change removes the setting that
   disables `groundwork@groundwork` there, sets it to enabled as in
   [plugin/README.md](plugin/README.md). Before any built-in copy is deleted,
   the move's release is [published](plugin/README.md#release-a-new-version)
   and every machine that works in that repository is
   [updated](plugin/README.md#update-pin-or-remove) to it, since a machine keeps
   its installed release until updated. A fresh session there then lists that
   release's version and every command the step-1 inventory moved (the drive
   loop, the review skill and `do-issue` among them, not only the review
   skill). The review skill prefers a sibling skill
   in the repository's own `.claude/skills/` over the one beside it in the
   plugin, so the end-to-end check runs in a disposable checkout of that
   repository with the built-in coupled set absent. A drive-loop run there
   completes a review round, and the sibling paths the run invokes are
   confirmed to belong to the installed release. The copies are deleted only
   after Groundwork's gates and the moved suites pass, the reference
   implementation's own gates and tests pass with the built-in set absent, and
   the same checks have run under both Claude Code and Codex.

**Status: landed with plugin 0.3.0** (2026-10-11). Step 3 moved into the
plugin:

- `drive-pr`, including its fleet-health and fractal-metrics reports;
- the issue-pickup skill as `do-issue` (since renamed `do-item`; see
  [Configuration and naming follow-ups](#configuration-and-naming-follow-ups),
  item 3), which reaches the tracker only
  through the [tracker interface](GLOSSARY.md) and its Linear adapter;
- the [Review Arbiter](GLOSSARY.md) as the plugin agent `review-arbiter`;
- drive-pr's terminal-states consistency check and the rule document it
  enforces.

The organization's values for these arrive through new
`.config/groundwork-overlay.yaml` fields
([plugin/README.md](plugin/README.md#the-drive-loop-and-issue-pickup)).
Groundwork's CI runs the drive-pr suite, split into four parallel shards on
Linux and macOS, and the terminal-states check; Windows leaves out the
POSIX-only drive-pr and `do-item` suites
([scripts/gates.ts](scripts/gates.ts)). The paired step-4 change deleted the
reference implementation's own copies, including its frozen review skill, and
enabled the plugin there.

Stays with the reference implementation and calls the plugin: its Herdr
status board, the drive-loop banner hook, the refocus hook, its dashboard
collectors, and the debt report.

### Values the moved skills still assume

Step 2 split most of the organization's values into configuration, but a
second consumer showed that the split missed some. Plugin 0.5.0 moves these
into configuration:

- the continuous-integration checks a drive waits for, now
  `ci.required_checks`, derived from the base branch's protection by default;
- the [CI hold](GLOSSARY.md), now opt-in through `ci.hold_label`;
- the AI reviewer's check name and comment markers, now `review.*` fields.

The reference implementation relies on the hold, so its configuration gains
`ci.hold_label` and `ci.required_checks` before its machines update to 0.5.0.
An older release ignores the new fields; without them, 0.5.0 runs full CI on
every push there, and a drive that still owns a label from an earlier release
stops and names the missing setting instead of leaving the label behind.

Plugin 0.7.0 makes how agents open pull requests a declared policy instead of
an improvisation: `pull_requests` (stacking, stack depth, branch names, draft
or Ready, when the drive marks a draft Ready, issue link, size budget,
labels), applied by `do-issue`'s `pr-plan.ts` (the skill is now `do-item`).
Merging stays a human step;
delegating it is queued below. Every configuration field is now listed in one
[reference](plugin/CONFIGURATION.md). A consumer that stacks pull requests
declares `stacking` before its machines update; without it, 0.7.0 refuses to
stack.

Plugin 0.8.0 reads the labels the skills act on (epic, human-in-the-loop
flag, manual operations, review follow-up, bug, pattern, batch sizes, the
tails an epic may hand off) from `issue_tracker.labels`, and the
parent-status reconciliation reads the tracker's own state names from
`issue_tracker.states`.

Still bound to the reference implementation's setup, to move into
configuration when the next consumer needs them:

- the review skill's deferral step (`defer-batch.ts`) calls Linear directly,
  with fixed label groups, instead of going through the tracker interface;
- the drive pushes to and fetches from a remote named `origin`;
- summary-finding severity is read only from the two reviewers the reference
  implementation runs.

## Skill moves after the drive loop

With the drive loop moved, the remaining reference-implementation skills were
re-evaluated one by one (2026-10-11). A skill moves when its procedure is
generic and the organization's values in it can become configuration or be
detected from the repository. It stays when most of its content is the
organization's own workflow. Each move follows the [AGENTS.md](AGENTS.md)
rules: the skill brings its own tests, its tracker references are resolved,
and the reference implementation's copy is deleted in a paired change once
every machine that works there has the release that adds it.

**Batch 1: procedure skills** (plugin 0.6.0). Mostly instructions. Their only
code dependencies outside the skill are on skills the plugin already ships:
`adr`'s and `fix-ci`'s scripts import the review skill's shared helpers
(`resolve-review-comments/scripts/lib/`), `fix-ci` runs the drive loop's
round planner, and `review` lists threads through the review skill's script.
The batch therefore needs no new seam:

- `descar` (pairs with M4's de-scarring lint), `promote-memory` (M8's memory
  promotion cycle) and `adr` (M5);
- `review` (reviews a diff against the repository's standards and decision
  rules), `fix-ci` and `github-actions`;
- `programmatic-execution` and `design-brief-builder`.

Their paths into the organization's repository become overlay fields or
detection. `fix-ci`'s Bash and Python log parser is first replaced by a Bun
script in the reference implementation and operated there; that exact source
and its tests then move with the skill, so the move never rewrites a parallel
copy.

Status: in the plugin from 0.6.0 (configuration in
[plugin/README.md](plugin/README.md#the-procedure-skills)). The scripts the
skills ran in Bash (`descar`'s open-pull-request exclusion, corpus order and
reading list; `adr`'s rules validation) are Bun scripts with tests. The
`fix-ci` parser's output matched the Python parser's on the same fixtures,
apart from intended changes: a regeneration hint that names the configuration
field, and drift hints recognised for every package manager. The reference
implementation's copies are deleted in a paired change once 0.6.0 is
installed where it works.

**Batch 2: decision and explainer sheets** (plugin version not yet
assigned). `decide` and
`explain` move as one unit. They render the same kind of sheet from a typed
source, and today each keeps its own copy of the shared rendering kit,
synchronized by a hook; in the plugin one copy serves both. The organization's
colour palette becomes a neutral default.

`decide` also checks the prose of a decision request with a vendored
[Simplified Technical English](GLOSSARY.md) linter (`ste-lint`, Python, written by a third
party under a permissive licence), wrapped by a local Python script.
Groundwork ships no Python, so both are rewritten in TypeScript in the
reference implementation, which operates the port before the move brings that
exact source and its tests here:

1. Port the upstream linter and the wrapper into one Bun module with the same
   command-line flags, JSON output and exit codes.
2. Capture the Python output for every existing fixture and a corpus of real
   decision texts, and require identical findings (rule, line and severity)
   from the port. Record the comparison in the
   [migration parity record](scripts/migration-parity.md).
3. Keep the upstream licence notice with the port: it is a translation of that
   code.
4. Delete the Python files once the port replaces them in the reference
   implementation, before `decide` moves.

**Later:** `scaffolding-update` (keeps agent instruction files in step with
decisions and audits them; M0), with its paths as configuration; and
`solid-review`, once its generic procedure is split from the stack-specific
checks it carries today.

**Stays with the reference implementation:** `followup` (post-merge triage,
including the epic-closure sweep) and `ops-drain`, both built around that
organization's promotion ledger; `epic-acceptance-review` and the
`debt-report`; the issue-label skills `linear` and `linear-validation`, whose
generic part already exists as M9's label taxonomy and lint; and the
product-bound skills the extraction inventory lists.

**Not moved: third-party lineage.** Groundwork may be published. A skill that
came from a public skill collection, or that still visibly follows one, does
not move here; a repository that wants it installs it from its source. This
excludes `skill-creator` and `webapp-testing` (Anthropic's skills), `caveman`,
`zoom-out`, `resolving-merge-conflicts`, `diagnosing-bugs` and
`requirements-brainstorm` (adapted from mattpocock/skills), `verify-completion`
(obra/superpowers), and `freeze` and `product-review` (garrytan/gstack). A
debugging skill may still be written for Groundwork from scratch; it does not
start from `diagnosing-bugs`.

## Configuration and naming follow-ups

The pull-request policy (plugin 0.7.0) made the first group of
per-repository choices explicit. These follow it, in this order. Each is its
own pull request, opened against `main` once the one before it merges
(Groundwork's own `pull_requests.stacking` is `none`).

1. **Delegated merge (`pull_requests.merge: auto-on-converged`).** Lets a
   converged drive arm the forge's auto-merge for the exact head it
   certified. It relaxes "a human merges", so the doctrine change is approved
   on its own. Work in progress is on branch
   `feature/auto-merge-on-converged`; before it opens as a pull request the
   design must guarantee that:
   - the delegation and the merge method are read only from sources the pull
     request cannot change, fetched fresh at the moment of the decision, and
     the integration branch is resolved independently of the pull request's
     own `repository.base_branch`;
   - revoking the delegation, or any condition that refuses it, withdraws an
     auto-merge an earlier run armed, whatever the policy then says;
   - `drive.ts` leaves the decision to the helper instead of gating on the
     pull request's own copy of the policy;
   - an armed auto-merge is bound to the certified head and cannot arm before
     the reviewers summoned by Ready have reported;
   - the doctrine (M7 invariant, the human-in-the-loop registry's Merge row,
     the maturity criteria) changes in the same pull request, in the
     direction the decision picks.
2. ~~**Tracker labels.**~~ — ✅ done 2026-10-11 (plugin 0.8.0).
   `issue_tracker.labels` maps each label role the skills act on (epic, the
   human-in-the-loop flag and its facets, manual operations, review follow-up, bug, pattern prefix, batch sizes, the tails
   an epic may hand off) to the tracker's own label, and the parent-status
   reconciliation reads `issue_tracker.states`.
3. ~~**Rename `do-issue` to `do-item`.**~~ — ✅ done 2026-10-11 (plugin
   0.9.0). "Issue" tied the skill to one kind of tracker; the skill picks up a
   work item from whatever the tracker adapter reads, including a plan file.
   The skill directory, the `/groundwork:do-item` command, the plugin
   manifests and documentation, the path pattern `drive-pr`'s
   `lib/pass-child.ts` recognises as a skill script, and the configuration
   section (`do_issue` → `do_item`) all changed together, with no
   compatibility alias: a `do_issue` section is no longer read, and the skill
   stops and names the rename rather than running without it. Consumers
   update their instructions and configuration in a paired change before
   their machines update.
4. ~~**Stacked pull requests in `drive-pr`.**~~ — ✅ done 2026-10-11 (plugin
   0.9.1). A round's validation plan and change set use the pull request's
   own base, so an upper layer's plan covers that layer alone and the
   pre-push check of the files a round touched no longer counts commits a
   base sync brought in from the layer below. A stacked layer's required checks are its base's plus
   those of the branch the stack's bottom layer targets. Base syncs stay
   merges: no rebase or force-push under a running drive.
5. **`/groundwork:audit`.** The auditor as a recurring skill rather than a
   one-time adoption step. `audit/` moves into `plugin/skills/audit/`, leaving
   a pointer. It has two layers: a mechanical check of how the repository's
   configuration fits (unknown or deprecated keys, derivations that fail,
   declared values the repository contradicts, unused features), and the
   module maturity scoring. A committed `.config/groundwork-audit.yaml`
   records the version audited, the scores, and declined recommendations with
   a revisit condition, so a re-run reports what is fixed, still open,
   regressed or new. Configuration fields and maturity criteria gain
   `since: <version>` markers so a re-run can say what Groundwork added since
   the last audit. Read-only by default; applying is opt-in.
6. **More tracker adapters.** Jira and a plan file kept in the repository.
   Open decisions: the plan file's format (one file for the plan, or
   one per item), and whether the reporting operations of the tracker
   interface may be optional for an adapter that cannot answer them.
