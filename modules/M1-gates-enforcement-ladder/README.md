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
   they run. Cheapest first: the checks that take seconds run before the
   minutes of tests and build, so a failure is reported at the start of a
   run, not after the suite. The run goes to the end: a gate that depends on
   nothing but the tree runs whatever an earlier gate reported, the run
   closes with the list of what failed and exits non-zero if anything did,
   so two unrelated failures surface in one run rather than two. Only a gate
   that needs another's output is left out once that one fails.
2. **Hook layer** — pre-commit: auto-fixing checks that fix-and-stage
   (formatting, regeneration); pre-push: cheap pattern gates + the heavy
   build/test; commit-msg: process markers (e.g., "this migration was
   reviewed" tokens that a later gate verifies). A
   [change-area catalog](../M3-change-area-catalog/)'s `validation:`
   projection can scope the pre-push gate depth to what the change actually
   touched instead of always running the heaviest set.
3. **Gate-authoring rules** — one small script per codebase-wide rule
   ("no direct fetch calls in frontend", or
   [M15's](../M15-contracts-errors/reference/migration-immutability/) "a
   merged migration never changes"), each with a
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
   - **Classify before retrying.** A step that retries a command retries
     only an error it has classified as transient, and aborts at once on
     any other with the command's own message and status. The transient
     patterns live in a list with the reason beside each, and the
     [error classifier](../../GLOSSARY.md) is tested against messages
     recorded from the real tool: wording written from memory never
     matches, so an untested retry either never fires or retries
     everything, and a permission error retried to the end of its budget
     is reported as a timeout. The reference wrapper is
     [`reference/retry-classified/`](reference/retry-classified/)
     ([mappings.md](mappings.md#retries) places it per provider).
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
   [M14](../M14-testing-strategy/README.md)'s testing gates bring exceptions
   that belong here: the `fixed-delay:` token on a deliberate sleep, and the
   exemptions file of its tests-with-changes gate, which turns "changed
   files need tests" into a check. Neither yet prunes itself: the
   tests-with-changes gate refuses an exemption without a reason but passes
   one that no longer matches any file, and M14 ships no gate for the
   `fixed-delay:` token. Both are M14 future work, so review those entries
   by hand until it lands.
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
7. **Third-party automation and dependency integrity** — what runs on the
   team's machines and in its pipeline from outside the repository (CI
   actions, included automation, application dependencies) arrives only
   through a reviewed commit, and late enough to have been seen:
   - **Immutable pins with an update path.** External CI actions and included
     automation are pinned to immutable revisions, while an automated
     dependency updater proposes tested pin changes. An immutable pin without
     an update path becomes stale; an update bot without immutable pins leaves
     merge-time behavior changeable outside the reviewed commit. On GitHub
     Actions, M13's
     [workflow-convention lint](../M13-pipeline-economy/reference/workflow-conventions/README.md#pinned-uses)
     checks the pins of workflows and composite actions.
   - **A [release cooldown](../../GLOSSARY.md).** A dependency release is
     proposed by the updater, and resolved by every package manager at install
     time, only once it is older than a minimum age (a few days), so a release
     that is yanked or found compromised is usually gone before anyone here
     sees it. The installer's half matters: an updater alone leaves `add` and
     `update` on a developer's machine, and a lockfile refresh, free to take
     the newest release. The exemption list (a package version-locked to a
     runtime pin, which must move the day the pin moves) is short and names
     exact packages, never a pattern, since a pattern trusts whatever is
     published under it later. A fix for a known vulnerability takes the
     updater's security path, which skips the wait.
   - **An [install-script allowlist](../../GLOSSARY.md).** Only the packages
     a repository lists may run lifecycle scripts (preinstall, install,
     postinstall, prepare) at install time; the installer blocks every other
     package's scripts. A package on the list is never auto-merged by the
     updater: its new release runs code on every machine that installs it, so
     a person reads the diff.
   - **[Policy lockstep](../../GLOSSARY.md).** The cooldown, its exemptions and the allowlist are
     stated once, in one policy file, and every installer and the updater
     state the same values in their own configuration and their own units
     (days, minutes, seconds); a gate checks they agree. That gate runs before
     any install that could run a script (before the install step, or with
     scripts disabled), because a change that adds a package to the allowlist
     would otherwise run that package's script before the gate that judges it.
   - **The updater checks itself.** Range-valued version overrides (a security
     floor, a major cap) are excluded from the updater's normal path: it reads
     the cap as a dependency and proposes lifting it, which changes the range
     without fixing anything. Where the updater extracts a version with a
     custom pattern (a pin in source code, a workflow variable), a self-check
     re-applies each pattern to the tree and requires exactly one value, since
     zero matches is a successful run with nothing to update, not an error.
   - **Layered secret scanning.** A secret is caught in layers: a
     pre-commit hook on the committer's machine; a blocking CI scan over
     exactly the commits the change introduced, never the whole history, which
     fails on an empty range because a scanner handed no commits passes; and
     the forge's push protection, which catches a push that reaches neither.
     Each layer catches what the one before let through (`--no-verify`, a
     machine without the hook, a push outside a pull request).
8. **Agent-runtime hooks** — the rung between convention and the git hooks.
   An [agent-runtime hook](../../GLOSSARY.md) is a command the agent's
   runtime runs at its own events: before or after a tool call, when a
   prompt is submitted, when a session starts, resumes or compacts. It sees
   what no git hook can (the command an agent is about to run, before it
   runs; the prompt; the session's own transcript), so a rule that git can
   only catch once the damage is committed belongs here: a command that is a
   hard error under the shell the tool runs, or a session about to be
   aborted at the runtime's turn cap with no handoff written. It is the
   softer rung: the runtime loads a hook only where it is registered and
   trusted, and a session without it has nothing, so a hook enforces nothing
   CI does not re-check. Every hook holds to these rules:
   - **Local files only.** It reads the payload the runtime hands it, the
     transcript and the repository, never the network: it runs before every
     tool call, so a network call would add its latency and its failures to
     each one.
   - **Bounded cost.** It reads only what it must, such as the transcript
     since its last call (an offset kept in per-session state), never a
     whole file that grows to tens of megabytes in a long session; a line
     the runtime is still writing stays for the next call.
   - **Three outcomes, and it fails open loudly.** Checked and clear is
     silence, or context handed to the agent. A denial is reserved for a
     command that would fail deterministically anyway, so that the denial
     replaces a failed round-trip with a correction and never blocks a valid
     command. Could not check (a transcript it cannot read, state it cannot
     write, a format it does not recognise) lets the action through and says
     so where the runtime shows hook errors: a guard that blocks because it
     could not check is worse than what it prevents, and one that is silent
     when broken reads as checked and clear.
   - **Registered identically in every runtime that supports hooks.** One
     hook file and one registration shape, so a session in a second runtime
     carries the same guard; where a runtime does not supply what the hook
     reads, the hook reports could not check rather than counting nothing in
     silence.
   - **Self-tested, discovered in CI.** Each hook has a self-test beside it
     that feeds it the runtime's payload shape and asserts each outcome, and
     one runner ([`templates/hook-self-tests.sh`](templates/hook-self-tests.sh))
     discovers every hook's test and runs it in CI, so a new hook enters the
     gate without a second list to maintain.

## Maturity levels

- **Lite** — gate set documented + runnable with one command; hooks optional;
  CI runs the gates on every PR.
- **Standard** — full hook layer with auto-fix-and-stage; ≥ the team's top-5
  codebase rules as tested grep gates in hooks + CI; escape hatches
  documented; third-party CI automation is immutable and automatically
  updated; a release cooldown holds in the updater and in every installer,
  with exact-name exemptions; only listed packages run install scripts, and
  the updater never auto-merges them; a blocking CI secret scan covers each
  change's commits; repository-written gates report could not check (exit 2)
  apart from findings; every exception entry carries a non-empty reason the
  gate checks, and a stale entry fails its gate.
- **Strict** — suppression-token registry; commit-msg process markers for
  mandatory reviews; gate self-tests required, each including a case with
  nothing to examine (the input missing, or empty where its format requires
  content) that must not pass; advisory gates carry promotion conditions with dates;
  one supply-chain policy held to by a lockstep gate that runs before any
  install can run a script; the updater's self-check; every agent-runtime hook
  self-tested, its tests discovered and run in CI; a pre-commit secret
  hook and the forge's push protection beside the CI scan; a retry is
  taken only on an error classified as transient, by a classifier tested
  against messages recorded from the real tool;
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
   an updater for the pins; state the supply-chain policy from
   [`templates/supply-chain-policy.yaml`](templates/supply-chain-policy.yaml)
   and make the updater and every installer state its cooldown, exemptions
   and install-script allowlist ([`mappings.md`](mappings.md#release-cooldown)
   says which setting is which); add the blocking CI secret scan from
   [`templates/secret-scan.yml`](templates/secret-scan.yml). This is
   **Standard**.
3. Copy [`templates/suppression-registry.md`](templates/suppression-registry.md)
   and register every suppression token; add commit-msg markers for mandatory
   reviews with [`reference/commit-msg-marker/`](reference/commit-msg-marker/);
   run every gate's self-test in CI, each with a case where the input is
   missing, or empty where its format requires content, that must not pass;
   give each advisory gate a promotion condition
   and a date; hold the installers and the updater to the policy with
   [`reference/supply-chain-lockstep/`](reference/supply-chain-lockstep/),
   run before the install step; self-check the updater's custom patterns and
   keep range-valued overrides out of its normal path; give each
   agent-runtime hook a self-test and run them in CI through
   [`templates/hook-self-tests.sh`](templates/hook-self-tests.sh); add the
   pre-commit secret hook and turn on the forge's push protection. This is
   **Strict**.

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
- [`templates/supply-chain-policy.yaml`](templates/supply-chain-policy.yaml) —
  the one statement of the release cooldown, its exemptions and the
  install-script allowlist, which every installer and the updater repeat.
- [`templates/secret-scan.yml`](templates/secret-scan.yml) — a GitHub Actions
  workflow for the blocking layer of the secret scan: a pinned, checksummed
  scanner over exactly the change's commits, refusing an empty range.
- [`templates/hook-self-tests.sh`](templates/hook-self-tests.sh) — the runner
  that discovers every agent-runtime hook's self-test in a directory and runs
  them, failing a hook without a test and refusing a directory that is not
  there, with its own self-test beside it
  ([`templates/hook-self-tests.test.ts`](templates/hook-self-tests.test.ts)).
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
- [`reference/supply-chain-lockstep/`](reference/supply-chain-lockstep/) —
  the policy lockstep gate: reads the policy file and checks that each
  installer and updater file it is given states the same cooldown,
  exemptions and install-script allowlist, in that file's own units; with
  its fixtures and self-test.
- [`plugin/hooks/turn-budget-guard.ts`](../../plugin/hooks/turn-budget-guard.ts) —
  the turn-budget guard, the plugin's agent-runtime hook: before every tool
  call it counts the session's round-trips off the transcript and hands the
  agent a wrap-up instruction within a margin of the runtime's turn cap;
  registered by [`plugin/hooks/hooks.json`](../../plugin/hooks/hooks.json)
  and tested in [`plugin/hooks/__tests__/`](../../plugin/hooks/__tests__/).
- [`reference/retry-classified/`](reference/retry-classified/) — the
  classified retry: runs a command, retries it only on an error the pattern
  list classifies as transient, aborts at once on any other with the
  command's own output and status, and answers for a recorded message so
  the list is tested against the real tool's wording; with its self-test.
- [`mappings.md`](mappings.md) — hook managers (lefthook, husky, pre-commit),
  CI providers (GitHub Actions, GitLab CI), pin-and-update providers, the
  cooldown, install-script and self-check settings of each package manager
  and updater, the secret scanners per layer, and the hook systems of the
  agent runtimes; and
  the module's [maturity criteria](../../plugin/skills/audit/criteria/M1-gates-enforcement-ladder.yaml).

The self-tests for the grep gate and the commit-msg marker are in
[`scripts/freshness.test.ts`](../../scripts/freshness.test.ts); the
ratchet's and the lockstep gate's are beside each gate, in
[`reference/ratchet/`](reference/ratchet/) and
[`reference/supply-chain-lockstep/`](reference/supply-chain-lockstep/). Jig runs
this module on itself: `bun run gates` runs the repository's gate set cheapest
first and to the end, CI runs the same command on every pull request, and the
order is stated in [`CONTRIBUTING.md`](../../CONTRIBUTING.md#quality-gates).
Its ratchet covers Biome's warnings
(including Jig's GritQL rules in `tools/quality/grit/`), the compiler flags
being burned down and suppression comments. The
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md)
skill checks workflow changes against this module's pin-and-update invariant,
and [`/jig:fix-ci`](../../plugin/skills/fix-ci/SKILL.md) repairs a red
gate run from its log and verifies the fix locally before pushing.

Of third-party automation and dependency integrity (core piece 7), the
pin-and-update half is the invariant, the provider table in
[`mappings.md`](mappings.md#immutable-third-party-automation-and-updates)
and a Standard criterion, with no reference script; the policy lockstep ships
as [`reference/supply-chain-lockstep/`](reference/supply-chain-lockstep/) and
the secret scan's blocking layer as a workflow template, while the hook and
push-protection layers are rows in [`mappings.md`](mappings.md#layered-secret-scanning).
The updater's self-check has no reference either: the override rule is one
entry of the updater's configuration, and the extraction check is a few
lines that re-apply that configuration's own patterns to the repository's
tree, so each is written against the repository's own updater
([`mappings.md`](mappings.md#the-updater-checks-itself)). The lockstep gate
reads Bun's, pnpm's, Renovate's and Dependabot's files; npm's and yarn's
cooldown settings are future work for when a repository on them adopts it.
The gate lifecycle
(core piece 6) is stated as practice: no reference ships for the shadow job, the retirement record or the entry-point list, since each is a
few lines of the repository's own CI and configuration. The reference gate
writes GitHub annotations only; [`mappings.md`](mappings.md#actionable-findings-in-ci)
names GitLab's Code Quality report as the equivalent, and emitting one is
future work for when a GitLab repository adopts the gate.

Of agent-runtime hooks (core piece 8), the rung and its rules are the
invariant, the runtimes' hook systems are rows in
[`mappings.md`](mappings.md#agent-runtime-hooks), and the plugin ships a
hook, the turn-budget guard, which
[`/jig:drive-pr`](../../plugin/skills/drive-pr/references/terminal-states.md)
relies on to end a round before the runtime's cap. Jig's own CI runs the
hook's tests through the gate set's test stage, which discovers them by name;
the runner template is for a repository whose hooks are shell scripts or
whose tests sit outside its test runner's discovery. The other hooks the
mappings name, a guard against shell syntax that fails under the tool's
shell and a filter that trims a passing test run's output, are examples of
the rung, not shipped. A hook that re-injects a session's intent after a
compaction is future work: it waits on the comparison
[ROADMAP.md](../../ROADMAP.md#later) lists. So is the guard under Codex:
whether a could-not-check exit surfaces its notice there, and whether hooks
fire inside Codex's subagents, wait for a session that runs the hook in
Codex with the plugin trusted.

The audit scores these gate-authoring rules: the three outcomes, stale
exceptions failing, a self-test with nothing to examine, and retries that
classify. The other rules
(a scope line on green runs, actionable findings, a self-test recognizer
broader than the gate's, mutation-tested fixtures, the size of the parsed
population) and the gate lifecycle are not yet scored. Each needs an
observable fact a criterion can name, and finding one is future work.

### Jig's own gates

How Jig's own gate set meets these rules, and where it does not yet, is in
[CONTRIBUTING.md § Where Jig's gates fall short](../../CONTRIBUTING.md#where-jigs-gates-fall-short).
