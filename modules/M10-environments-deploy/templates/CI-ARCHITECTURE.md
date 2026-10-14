# Delivery architecture — verify, then promote

> Copy this into your repo (e.g. `docs/development/ci-architecture.md`) and
> adjust the tool names to your stack. It is the tool-independent contract; the
> per-provider wiring lives in Jig's
> [M10 mappings](https://github.com/docomply/jig/blob/main/modules/M10-environments-deploy/mappings.md), and
> the two enforcement gates in its
> [`reference/`](https://github.com/docomply/jig/tree/main/modules/M10-environments-deploy/reference).

## The core idea: "it merged" is not "it's verified"

Merging a pull request means the change is *on the main line*. It does **not**
mean the change *works where users are*. Those are different facts, and treating
them as the same is how a green merge becomes a production incident: the merge
button only knows that review passed and the per-PR checks were green on the
diff — it knows nothing about whether the integrated system, on the real branch,
with everything else that merged this hour, actually stands up.

So we keep the two facts separate, with an explicit marker for the second one: a
**verified pointer**. And we let *only the verified fact* reach production.

## The four stages

Delivery is four stages, each with one responsibility and a hard boundary to
the next; a stage may run several jobs.

| Stage | Runs on | Question it answers | Advances |
|-------|---------|---------------------|----------|
| 1. PR gates | every pull request | "Is this diff, in isolation, good enough to merge?" | nothing (informs the human merge) |
| 2. Post-merge verification | every push to the default branch | "Does the *integrated* branch actually work?" | the `verified` pointer |
| 3. Deploy | when `verified` advances | "Ship the thing we verified to a live environment, and confirm it is the thing running." | the deployed environment |
| 4. Promotion to production | a human's deliberate action | "Put the verified, deployed build in front of users, and confirm it is the thing running." | production |

The boundaries are the point: stage 2 never trusts stage 1's green ("merged" ≠
"verified"), stage 3 only ever deploys what stage 2 marked, and stage 4 never
fires itself.

### Stage 1 — PR gates (fast, per-diff, advisory to the human)

Every pull request runs the quick, diff-scoped checks: format, lint, unit tests,
type checks, the change-area-selected reviews (see
[M7](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review)), and any security/link/table gates. These
are necessary but **not sufficient** — they see the diff, not the integrated
system. A human still merges. PR gates *inform* that decision;
they do not certify production-readiness.

### Stage 2 — post-merge verification advances the `verified` pointer

After a merge lands on the default branch, a heavier suite runs against the
*integrated* branch: integration tests against real services, a real migration
against a production-like database, the build of every deployable artifact, a
smoke deploy to a throwaway environment. When (and only when) it passes, an
automated step moves the **`verified` pointer** — a branch or tag, e.g.
`refs/tags/verified` — to that commit.

This suite runs on every push, so it holds exactly what the pointer must wait
for: every check needed to trust the integrated state users depend on. When
end-to-end tests are the only check of a critical journey, those tests belong
here. What the pointer does not need, such as a slow full end-to-end sweep
whose journeys other checks already cover, or coverage measurement, runs on a
schedule (see [Where each suite runs](#where-each-suite-runs)).

The pointer is the whole trick. It is a durable, inspectable record of "the
newest commit we actually trust." Anyone — a human, a deploy job, a dashboard —
can ask "what's verified right now?" and get a commit, not a vibe.

#### The freshness watchdog (self-healing)

A pointer that only ever moves forward on success has a failure mode: if
verification *wedges* (a flaky suite, a dead runner, a stuck queue), the pointer
silently freezes while the branch races ahead. Nothing failed, so nobody is
paged — but "deploy verified" now means "deploy last week's code."

The fix is a **watchdog**: a scheduled check on how far the pointer lags the
default-branch tip (in commits and in time). When the lag crosses a threshold it
fails loudly — page on-call, and ideally trigger an automatic **heal** run
(re-kick verification from the current tip). This is a freshness gate on a
*pointer* instead of a file (see [M2](https://github.com/docomply/jig/tree/main/modules/M2-generated-artifact-freshness));
the runnable version is the [`verified-pointer`](https://github.com/docomply/jig/tree/main/modules/M10-environments-deploy/reference/verified-pointer).

### Stage 3 — deploy verified artifacts only

Deploys are driven by the pointer moving, and they deploy **what the pointer
points at** — never a raw branch, never `:latest`, never "whatever triggered
this run." Build the artifact once, from the verified commit (verification
already built it), and ship *that*: the same bytes in every environment,
addressed by digest (a content hash such as `image@sha256:…`), never by a tag
that can move. Per-environment settings are supplied at deploy time (a runtime
configuration file, environment variables), never compiled into the artifact,
so staging and production run identical builds. If a deploy job checks out
`main` instead of `verified`, the whole verify-then-ship chain is bypassed.

Every deploy ends with an **identity check**: the deploy is complete only when
the live environment reports the exact artifact identity that was shipped, its
rollouts are ready, and a readiness check that exercises the application's
critical dependencies passes (for an application with a database, one that
queries it).
"The deploy command returned" is not that fact. The deploy run also records a
manifest of what it actually deployed this run, and anything downstream (an
end-to-end run against the environment) reads that manifest.

### Stage 4 — manual, gated promotion to production

Production is reached by a **deliberate human action** on an
already-verified-and-deployed build — a manual trigger plus an environment
**protection rule** (required reviewers / a wait timer). It must be impossible
for a push to auto-promote to production. This is the last human checkpoint (a
[HITL](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review) boundary), and it is enforced by
configuration, not habit: the [`promote-safety`](https://github.com/docomply/jig/tree/main/modules/M10-environments-deploy/reference/promote-safety)
lint fails a production deploy that auto-fires, ships a mutable ref, or looks
its commit up again by name.

#### The promotion ships what it gated

A promotion is several jobs (gate, migrate, deploy, verify), and each one can
quietly ship something other than what the gate approved. So:

- **The first job resolves the `verified` pointer once** and outputs the
  commit it checked; every later job takes that commit from the output. A job
  that fetches a branch by name gets whatever the name points at when it
  starts, which can be newer than what the gate checked.
- **Promotions to one environment run one at a time, and none is dropped.**
  Use a queue or lock that keeps every request; a mechanism that keeps only
  the newest pending run silently discards a deliberate promotion. Refuse a
  re-run of a promotion, which keeps its original place in the order; start
  a new one. Check the lock again just before the migration.
- **The promotion runs from the [trusted ref](https://github.com/docomply/jig/blob/main/GLOSSARY.md)** (the `verified` pointer). A manually started workflow
  runs its definition from whichever branch the operator picks; start it from
  `verified`, check the gate's own code out from `verified`, and have the
  production environment admit only that ref.
- **Production ends with the identity check** above: the promoted digest is
  live, rollouts are ready, the readiness check passes. The run publishes its
  manifest of what it deployed.
- **Release state stays off the source line.** A release pointer (the branch
  that says what production runs) only fast-forwards to verified commits,
  and only after the identity check passes; a gated commit older than the
  pointer is refused before the promotion changes anything, checked again once
  it holds the lock.
  Rendered deployment manifests, when git drives the deploy, live on their own
  ref, written only by one dedicated machine identity; that ref's protection
  restricts who may push and requires no pull request, which a direct push
  could never satisfy.

## Where each suite runs

A suite runs per change only if a merge or the `verified` pointer waits for
its answer, and the pointer waits for every check it needs to be trusted. A
suite nothing waits for, such as a half-hour end-to-end sweep whose journeys
other checks already cover, or a coverage sweep, runs on a schedule or on
demand instead, with a cheap proxy per change in its place (for example,
"the end-to-end images still build").

The placement table, per change, after merge, on a schedule and on demand,
is Jig's
[M13 placement table](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/README.md#6-place);
fill in your own suites in the copy of its
[pipeline-economy template](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/templates/PIPELINE-ECONOMY.md).
Write the placement into the pipeline and check it: a heavy suite that gains
a per-change trigger drifts back into everyone's wait. A scheduled suite
reports its failures where someone will see them, and a schedule that
silently stopped running counts as failing, not as passing.

## The environment kit that makes verification real

Verification and preview are only as honest as the environments and data behind
them.

### Ephemeral preview environments

Every pull request (and every verification run) can spin up its **own disposable
environment** — a full running copy of the app at that commit, on its own URL,
torn down when the PR closes. They are meant to be **cheap and throwaway**: cattle,
not pets. The payoff is that "does it actually run?" gets answered on real
infrastructure before merge, and reviewers click a link instead of imagining the
behavior. Because they are disposable, a broken one is deleted, not debugged.

### A seeded, isolated, resettable test-data factory

Realistic tests need realistic data — but hand-maintained fixtures rot, and
sharing one dataset across runs makes tests flaky and order-dependent. A
**test-data factory** solves this: a programmatic way to **seed** a known,
realistic dataset on demand, with each run (or each preview environment) getting
its **own isolated tenant** so runs can't see or corrupt each other's data, and a
one-command **reset** back to the known state. The three properties are the
contract:

| Property | Why it matters |
|----------|----------------|
| Seeded | tests assert against a known, realistic starting state, not a hand-curated snapshot that drifts |
| Multi-tenant-isolated | parallel runs and preview environments never share or clobber data |
| Resettable | a run can return to the known state cheaply, so tests are repeatable and independent |

## The contract, in one breath

PR gates inform the human merge; post-merge verification advances an explicit
`verified` pointer and a watchdog keeps that pointer honest; suites neither
waits for run on a schedule, not per change; deploys ship only
what `verified` points at, built once and addressed by digest; production is
reached only by a gated, manual promotion that cannot auto-fire, passes the
gated commit from job to job, and runs one at a time; and no deploy is done
until the live environment reports the identity that was shipped. Preview environments are disposable, and test
data is seeded, isolated, and resettable.
