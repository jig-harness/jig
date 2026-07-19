<!--
  TEMPLATE — copy this file into your repo (e.g. docs/dispositions.md) and
  point your universal instruction file (AGENTS.md) at it. Adapt the
  placeholders; keep or drop dispositions to match your project's stage.
-->

# Dispositions — written behavioral defaults

A **disposition** is a behavioral default written down: how an agent (or
contributor) should lean when multiple approaches are viable. Writing
dispositions down does two things — it stops every agent from re-deriving
(or guessing) the project's stance, and it forces each stance to carry the
condition under which it stops applying.

**Every disposition must state its flip condition.** A disposition without
one becomes dogma: the project keeps paying for a default long after the
situation that justified it is gone.

## 1. Systematic over improvised (the baseline bias)

When multiple approaches are viable, default to the **disciplined,
systematic, methodical** one. This is the project's baseline bias — not a
mood, not a style preference. In practice:

- **Follow the established workflow** (issue → plan → implementation →
  quality gates → PR → review) over improvised shortcuts.
- **Mechanize checks** (validators, tests, type guards) rather than
  trusting manual vigilance or convention.
- **Cross-reference external sources of truth** (decision records, schema
  files, API specs, the tracker) — don't validate code against itself.
- **Fix root causes**, not symptoms. Prefer resolving a failing hook,
  migration conflict, or flaky test over bypassing it (`--no-verify`,
  `git reset --hard`, `--force`).
- **Treat bugs as classes, not instances.** When fixing a bug, grep briefly
  for siblings of the underlying class (missing filter, swallowed error,
  missing `await`, hard-coded value) before scoping the fix.
- **Document decisions** when they're non-obvious or load-bearing for
  future work.
- **Converge on a single canonical path** — retire the old form when
  introducing the new one, rather than letting parallel variants drift.
- **Scope commits and PRs** to one concern; don't bundle opportunistic
  refactors with feature work.

**Flip condition**: the user explicitly signals a different mode — a spike,
prototype, or time-boxed experiment. Deviate then, and call out the
deviation so it's visible. Never flip silently.

## 2. Minimalism decision ladder

Before writing code, walk the ladder and **stop at the first rung that
satisfies the need**:

1. Does this need to exist at all?
2. Does the language / standard library already do it?
3. Is there a native feature of a platform you're already on
   (<database>, <framework>) that does it?
4. Does an already-installed dependency do it? (Do not add a new one
   without going through your dependency policy.)
5. Is it one line?
6. Only then: write the minimum that works.

**Boundary — coverage is not scope.** Never trade these away to satisfy
the ladder: validation, error handling, security, tenant isolation,
accessibility, and required tests / migrations. The ladder trims **what
you build**, never **how completely you build it**.

**Flip condition**: per task, the same explicit spike/prototype signal as
disposition 1. Per rung, re-walk the ladder when the ground shifts — a
platform or dependency you already have ships the feature, or a repeated
hand-rolled snippet shows the need has outgrown rung 5.

## 3. Backward compatibility — deferred until <flip event>

<!-- This is the canonical example of a lifecycle-stage disposition: a
     default that is CORRECT for one stage and a BUG in the next, which is
     exactly why the flip condition must be written down. Adapt the flip
     event to your project: first real customer data, first public API
     consumer, first external plugin, … -->

**Current stance (as of <date>)**: backward-compatibility concerns are
**explicitly deferred**. Production is empty / data is disposable. Prefer
the clean, systematic solution every time — do not introduce compat shims,
feature-flagged dual paths, renamed-but-kept columns, deprecated-field
tolerance, or "accepts both old and new" parsers to preserve non-existent
data.

Concretely, right now it is correct to:

- **Rewrite** a migration in place rather than chain a fix-forward
  migration, when the original hasn't shipped to a real user.
- **Rename** a column/field and update all call sites in one PR — no
  alias, no deprecation window.
- **Break** an API contract when the cleaner shape is obvious — consumers
  regenerate in the same PR.
- **Drop** a flag, endpoint, or code path the moment it's superseded.
- **Reset** disposable environment data rather than migrate it.

If you find yourself adding backward-compatibility machinery today, stop
and flag it — the default answer is "delete the old path instead."

**Flip condition**: <the event — e.g. "the first real customer's data is
onboarded", tracked at <milestone/issue>>. From that point, backward
compatibility becomes a first-class concern: breaking changes require
migration paths, dual-write windows, deprecation notices, and versioning.
Update this section the day the event happens.

## Adding a disposition

One heading per disposition. State: the default, what it looks like in
practice (a few bullets), and the flip condition. If you cannot name a
flip condition, it isn't a disposition — it's either a permanent guardrail
(put it in the universal instruction file) or an unexamined habit (examine
it).
