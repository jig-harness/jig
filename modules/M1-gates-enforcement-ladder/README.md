# M1 — Gates & enforcement ladder

**What problem this solves.** Most teams have more rules than enforcement:
"we always run the tests," "we never commit secrets," "new files need tests."
Whatever isn't mechanically checked erodes — especially with AI agents
generating high volumes of plausible-looking change. This module is the
machinery that turns stated rules into checks, ordered along an explicit
ladder from convention to hard gate, without collapsing into bureaucracy.

## Invariant

> A canonical, ordered set of quality gates is stated in one place and
> enforced at (at least) two rungs: locally via git hooks for fast feedback,
> and in CI as the authority. Every additional rule names its rung; every gate
> has a tested implementation and a documented, justified escape hatch.
>
> A gate has three outcomes: **passed**, **found violations**, or
> **[could not check](../../GLOSSARY.md)** (exit 0, 1 and 2). It never turns
> input it could not find or read into an empty, passing result, and a
> skipped or stale result is never evidence that a change passed. Each
> finding says which rule, where, what is wrong and how to fix it, and
> each exception carries a checked reason and fails the gate once it no
> longer suppresses anything.

Without the third outcome, a gate that could not read its input reports
nothing found, which looks exactly like a clean change: a renamed folder, a
section someone deleted or a command that failed quietly turns the check off
while it keeps saying green. Without actionable findings, the person or agent
who meets a red gate has to reverse-engineer the rule before fixing anything.
Without self-pruning exceptions, an allowlist only grows, and each entry left
behind is a place the rule silently no longer applies.

## Core pieces

1. **The gate set** — the ordered commands (format → lint → types → tests →
   build) stated once (in the M0 instruction file) and identical everywhere
   they run.
2. **Hook layer** — pre-commit: auto-fixing checks that fix-and-stage
   (formatting, regeneration); pre-push: cheap pattern gates + the heavy
   build/test; commit-msg: process markers (e.g., "this migration was
   reviewed" tokens that a later gate verifies). A
   [change-area catalog](../M3-change-area-catalog/)'s `validation:`
   projection can scope the pre-push gate depth to what the change actually
   touched instead of always running the heaviest set.
3. **Gate-authoring rules** — one small script per codebase-wide rule
   ("no direct fetch calls in frontend", "no DML in migrations"), each with a
   paired self-test and fixtures, wired into both pre-push and CI. Every
   gate, a [grep gate](../../GLOSSARY.md) or any other, is written to these
   rules:
   - **[Fail closed](../../GLOSSARY.md).** An input or section the gate
     cannot find, a row that cannot be decoded, a repeated key where keys
     must be unique, or a command the gate runs that failed is reported as
     could not check (exit 2), never skipped. So is an input found empty
     where its format requires content: a scan root with no file in it, a
     glossary that defines no term. A message for this outcome cannot be
     mistaken for a finding: the fix is to the input or the environment,
     not to the code under check.
   - **Empty is valid only where the format says so.** An input that is
     present and legitimately allows zero entries (a registry with no
     metrics yet, a log with no events, a review with no threads) passes
     when empty, and the gate's scope line says it examined zero entries.
     What fails closed is the gate not finding or not reading what it is
     meant to examine, never an empty list the format permits.
   - **Count what was read.** The gate checks the size of the population it
     parsed (files scanned, rows read, entries found), so that reading
     nothing can never look like finding nothing.
   - **Match text only for questions about text.** A text pattern is fine for
     "does this text appear". Whether code executes or a value binds is a
     question about structure: answer it with a real parser (a YAML loader, a
     syntax tree, a structural lint rule such as a
     [GritQL](../../GLOSSARY.md) rule run by a pinned linter), or pin the
     exact expected text. A hand-written pattern that guesses at structure
     stays one counterexample behind for ever. A parser that meets input
     outside the subset it models refuses loudly, as could not check, rather
     than reporting nothing found. Each linter's mechanism is in
     [mappings.md](mappings.md#custom-lint-rules-and-the-ratchet).
   - **The self-test reads more than the gate.** Where a self-test checks
     the gate's coverage, its recognizer (the code that decides which lines
     or entries count as the thing being checked) is strictly broader than
     the gate's, so a construct the gate cannot read still fails the test.
     A test that shares the gate's recognizer agrees with it about what
     neither read.
   - **Every fixture is [mutation-tested](../../GLOSSARY.md).** A guard
     counts as tested only once removing it, in a scratch copy, turns its
     fixture red. In a chain of fail-closed checks, each clause gets a
     fixture that passes every other clause, so that clause alone decides the
     outcome.
   - **The output states its scope**, on green runs too: what was examined
     and what the gate does not check ("142 files scanned; checks TODO
     comments only"). A green run is evidence about what the gate reached,
     and a reader of the summary should not have to open the source to learn
     how far that is.
   - **Findings are actionable.** Each finding names the rule, the place
     (file and line), the problem and the remedy, or the document that
     states it. In CI the findings are also written as the platform's
     annotations, so they appear on the changed lines
     ([mappings.md](mappings.md#actionable-findings-in-ci)).
4. **CI as authority** — every hook-enforced check re-runs in CI; local
   bypasses (`--no-verify`) exist for emergencies but change nothing about
   what merges. A check that was skipped, or that ran on an earlier commit,
   says nothing about the commit being merged: the required verdict counts
   it as not passed.
5. **Suppression-token registry, and exceptions that prune themselves** —
   the documented set of inline markers and allowlists that legitimately
   silence a specific gate at a specific spot. Ad-hoc suppressions are drift.
   Every exception, an inline token or an allowlist entry alike, carries a
   non-empty reason the gate checks, and an entry that no longer suppresses
   anything (the code it excused is gone, or the rule no longer flags it) is
   itself a finding. Exceptions therefore leave with what they excused,
   instead of piling up as places the rule quietly stopped applying.
6. **Advisory→blocking pipeline and the gate lifecycle** — new gates may
   start advisory, but each advisory gate carries a promotion condition;
   advisory-forever is a tracked smell. Between the two sits the
   [ratchet](../../GLOSSARY.md): a rule with existing findings blocks only
   changes that add to them, measured against the merge base, and is promoted
   to blocking when its count reaches zero. The rest of a gate's life follows
   the same care:
   - **Rules come from recurring findings.** A review finding that keeps
     coming back, and whose shape is syntactic, becomes a lint rule with
     fixtures (the forms it catches, look-alikes it must leave alone, the
     misses it accepts), held by the ratchet. Existing violations are
     rewritten in bulk by a separate rewriting tool, applied on purpose in its
     own change and never run as a gate.
   - **A replacement earns its place.** A tool meant to replace a gate (a
     faster linter, a new formatter) first runs in a non-blocking
     [shadow job](../../GLOSSARY.md) on every change, publishing parity
     counts: what each tool reports on the same tree, and where they
     differ. It takes over only once the differences are understood and
     closed; a release of the new tool alone is not a reason.
   - **Retiring a gate is recorded.** Next to the list of gates, a retired
     one keeps a line saying what replaced it and which coverage was lost, so
     nobody assumes a check still runs that does not.
   - **Unused code ([dead code](../../GLOSSARY.md)) and duplication are
     measured on every change**, with the entry points (the files nothing
     imports because a hook, a workflow, a test runner or a person runs them
     by path) declared one by one from how each is actually invoked. A
     folder-wide entry pattern marks every helper under it as used for ever,
     so the measurement can no longer find it once its last caller goes.
7. **Third-party automation integrity** — external CI actions and included
   automation are pinned to immutable revisions, while an automated dependency
   updater proposes tested pin changes. An immutable pin without an update
   path becomes stale; an update bot without immutable pins leaves merge-time
   behavior changeable outside the reviewed commit.

## Maturity levels

- **Lite** — gate set documented + runnable with one command; hooks optional;
  CI runs the gates on every PR.
- **Standard** — full hook layer with auto-fix-and-stage; ≥ the team's top-5
  codebase rules as tested grep gates in hooks + CI; escape hatches
  documented; third-party CI automation is immutable and automatically
  updated; repository-written gates report could not check (exit 2) apart
  from findings; every exception entry carries a non-empty reason the gate
  checks, and a stale entry fails its gate.
- **Strict** — suppression-token registry; commit-msg process markers for
  mandatory reviews; gate self-tests required, each including a case with
  nothing to examine (the input missing, or empty where its format requires
  content) that must not pass; advisory gates carry promotion conditions with dates;
  cross-worktree resource mutex where parallel agents share a machine (see
  M12).

## Adoption steps

1. Write the ordered gate set once in the universal instruction file
   ([M0](../M0-instruction-architecture/)), make one command run all of it,
   and run that command in CI on every pull request as a required check
   (skeleton: [`templates/ci-pr-gates.yml`](templates/ci-pr-gates.yml)). This
   is **Lite**.
2. Add the hook layer from [`templates/lefthook.yml`](templates/lefthook.yml)
   (husky and pre-commit equivalents in [`mappings.md`](mappings.md)); turn
   your top codebase rules into grep gates with self-tests, following
   [`reference/grep-gate/`](reference/grep-gate/), and run them in both the
   pre-push hook and CI; write them, and bring the gates you already have, to
   the gate-authoring rules (core piece 3): three outcomes, a counted
   population, findings with a fix; require a reason on every exception and
   fail on stale ones; document the `--no-verify` escape hatch next to the
   hooks; pin third-party CI automation to immutable revisions and configure
   an updater for the pins. This is **Standard**.
3. Copy [`templates/suppression-registry.md`](templates/suppression-registry.md)
   and register every suppression token; add commit-msg markers for mandatory
   reviews with [`reference/commit-msg-marker/`](reference/commit-msg-marker/);
   run every gate's self-test in CI, each with a case where the input is
   missing, or empty where its format requires content, that must not pass;
   give each advisory gate a promotion condition
   and a date. This is **Strict**.

## Status

What this module provides:

- [`templates/lefthook.yml`](templates/lefthook.yml) — the hook layer's shape:
  fix-and-stage pre-commit, pre-push grep gates then the heavy phase,
  commit-msg markers.
- [`templates/ci-pr-gates.yml`](templates/ci-pr-gates.yml) — a GitHub Actions
  pull-request workflow: one resolver job that selects the work from the
  change-area catalog ([M3](../M3-change-area-catalog/)), grep gates with
  their self-tests first, the gate set, tests on a parallel runner, a timeout
  on every job, and one aggregator job that is the only required check. Why
  it has that shape, and how to keep a pipeline cheap without weakening it,
  is [M13 pipeline economy](../M13-pipeline-economy/README.md): M1 decides
  what is checked, M13 how cheaply and how fast.
- [`templates/suppression-registry.md`](templates/suppression-registry.md) —
  the registry page for suppression tokens and process markers.
- [`reference/grep-gate/`](reference/grep-gate/) — the grep-gate convention
  with one worked gate (a TODO must cite an issue) and its fixtures: three
  outcomes, a scope line on green runs, findings with a fix, GitHub
  annotations in CI, and a stale suppression as a finding. Its finding and
  annotation format comes from Jig's shared helper
  [`lib/findings.ts`](../../lib/findings.ts).
- [`reference/commit-msg-marker/`](reference/commit-msg-marker/) — the
  commit-msg hook script for review markers, with its design notes.
- [`reference/ratchet/`](reference/ratchet/) — the ratchet gate: counts
  findings per rule in the working tree and the merge base, fails when a
  count grows or a configuration loosens a rule, and reports rules ready for
  promotion; with its self-tests.
- [`mappings.md`](mappings.md) — hook managers (lefthook, husky, pre-commit),
  CI providers (GitHub Actions, GitLab CI) and pin-and-update providers; and
  the module's [maturity criteria](../../plugin/skills/audit/criteria/M1-gates-enforcement-ladder.yaml).

The self-tests for the grep gate and the commit-msg marker are in
[`scripts/freshness.test.ts`](../../scripts/freshness.test.ts); the
ratchet's are in [`reference/ratchet/`](reference/ratchet/) beside the gate. Jig runs
this module on itself: `bun run gates` runs the repository's gate set in order,
CI runs the same command on every pull request, and the order is stated in the
root [`AGENTS.md`](../../AGENTS.md). Its ratchet covers Biome's warnings
(including Jig's GritQL rules in `tools/quality/grit/`), the compiler flags
being burned down and suppression comments. The
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md)
skill checks workflow changes against this module's pin-and-update invariant,
and [`/jig:fix-ci`](../../plugin/skills/fix-ci/SKILL.md) repairs a red
gate run from its log and verifies the fix locally before pushing.

Third-party automation integrity (core piece 7) is stated as the invariant,
the provider table in [`mappings.md`](mappings.md#immutable-third-party-automation-and-updates)
and a Standard criterion; it has no reference script. The gate lifecycle
(core piece 6) is stated as practice: no reference ships for the shadow job, the retirement record or the entry-point list, since each is a
few lines of the repository's own CI and configuration. The reference gate
writes GitHub annotations only; [`mappings.md`](mappings.md#actionable-findings-in-ci)
names GitLab's Code Quality report as the equivalent, and emitting one is
future work for when a GitLab repository adopts the gate.

The audit scores these gate-authoring rules: the three outcomes, stale
exceptions failing, and a self-test with nothing to examine. The other rules
(a scope line on green runs, actionable findings, a self-test recognizer
broader than the gate's, mutation-tested fixtures, the size of the parsed
population) and the gate lifecycle are not yet scored. Each needs an
observable fact a criterion can name, and finding one is future work.

### Jig's own gates

Jig's repository checks (`CHECKS` in [`scripts/gates.ts`](../../scripts/gates.ts))
and its ratchet exit 2 when they could not check, state their scope on green
runs; the change-area and review-risk checks fail on a repeated key in the
YAML they read. The Markdown, glossary
and origin-reference checks also write findings in the shared format with
GitHub annotations, and their exception lists (`scripts/glossary-allowlist.txt`,
the allow patterns in `scripts/tracker-key-patterns.txt`) need a reason per
group and fail on an entry that suppresses nothing. Where a gate does not yet
meet a rule:

| Gate | Rule not yet met | Why |
|------|------------------|-----|
| `check-licences`, `check-changelog`, `check-audit-fit`, `change-areas --check`, `review-risk --check`, `check-workflow-safety` | Findings name no rule and are not annotated in CI | Their messages already name the file and the fix in prose; moving them to the shared format is open work |
| `check-instruction-paths` | Findings name no rule or fix | It reports through M2's referenced-paths check, whose output format belongs to M2 |
| The ratchet (`bun run quality`) | A missing merge base passes locally, reported as skipped | So the pre-push hook works in a shallow clone; CI, the authority, exits 2 |
| Unused code (`bun run deadcode`, fallow) | Entry points are declared by folder pattern in `.fallowrc.jsonc` (the scripts, tools, skill scripts and reference gates folders) rather than file by file | Those folders hold the scripts a hook, CI, a skill or a reader runs by path; listing each from its invocation is open work |
