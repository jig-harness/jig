# M10 — Environments & deploy

**What problem this solves.** "It merged" and "it works where users are" are
different facts, and shipping as if they were the same is how a green merge
becomes a production incident. Merging means a change is on the main line and its
per-diff checks were green; it says nothing about whether the *integrated*
system — on the real branch, with everything else that landed this hour — stands
up. Without an architecture that keeps these two facts apart, teams either deploy
too eagerly (every merge reaches users, and a bad one gets there before anyone
looks) or too fearfully (deploys are a rare, manual, scary event). This module is
the pipeline shape that separates them: verify what merged, mark it explicitly,
deploy only the marked thing, and let a human make the final call to production.
It also covers the environment kit that makes verification honest — disposable
preview environments and a seeded, isolated, resettable test-data factory.

## Invariant

> The delivery pipeline keeps **"merged" and "verified" as separate facts**: PR
> gates run on every pull request and inform a human merge; **post-merge
> verification** runs on the integrated default branch and advances an explicit
> **`verified` pointer** (a branch or tag) only on success; a **watchdog**
> decides *why* that pointer lags, heals a dropped trigger within a budget of
> attempts and fails on the faults a person must repair, so a stalled
> verifier pages someone instead of silently shipping stale code; **deploys ship only what
> `verified` points at**, never a mutable branch or `:latest`; and **promotion
> to production is a manual, gated human action** that cannot auto-fire. A
> promotion **ships the exact commit and artifact its gates approved**,
> [built once](../../GLOSSARY.md) and passed from job to job, and is complete only when the live
> environment reports that identity. Preview environments are disposable and
> cheap; test data is seeded, tenant-isolated, and resettable. **Every
> resource the pipeline creates has a reaper** keyed to its owner, with its
> expiry set when it is created; **which changes have reached which
> environment is read from version-control ancestry**, never kept by hand;
> and a check against an environment that is deliberately behind **confirms
> the environment's currency first**, dropping its cell rather than reporting
> a false red or a false green.

> External preconditions are declared as intended state and checked read-only
> on a schedule under their consuming identity. Unreadable, pending and expired
> exceptions never pass; findings keep one current issue until recovery.

Everything below is that tool-independent statement made mechanical;
concrete per-provider wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **The four stages** — delivery is PR gates → post-merge verification →
   deploy → promotion, each with one responsibility and a hard boundary to the
   next, however many jobs it runs. Stage 2
   never trusts stage 1's green, stage 3 only ships what stage 2 marked, stage 4
   never fires itself. The copyable contract is
   [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md); the
   provider-neutral spine is [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml).
2. **The `verified` pointer** — an explicit, inspectable marker (a branch or tag,
   e.g. `refs/tags/verified`) that names "the newest commit we actually trust."
   Post-merge verification is the *only* thing that advances it, and deploys read
   it. It turns "is this good enough to ship?" from a vibe into a commit anyone
   can query.
3. **The watchdog** — a scheduled check that asks why the pointer lags the
   default-branch tip and answers by cause: nothing to verify, verifying,
   blocked by failed gates, a dropped trigger it heals, heals that keep
   ending without a verdict, a pointer that did not move after a success, a
   diverged pointer, a run stalled waiting for a runner. If verification wedges, the pointer freezes silently; the watchdog
   makes that silence loud and heals the one cause a machine can. It is a
   [freshness gate](../../GLOSSARY.md) on a *pointer* rather than a file, the
   same move [M2](../M2-generated-artifact-freshness/) makes for generated
   files, with [the decision a pointer needs](#the-watchdog-decides-by-cause),
   and it ships as [`reference/verified-pointer/`](reference/verified-pointer/).
4. **Deploy verified artifacts only** — deploy jobs are driven by the pointer
   moving and check out *what it points at*, never a raw branch or a moving tag.
   A deploy that reads `main` instead of `verified` bypasses the whole chain.
5. **Manual, gated promotion** — production is reached by a deliberate human
   action on an already-verified, already-deployed build, behind an environment
   **protection rule** (required reviewers / wait timer). It must be impossible
   for a push to auto-promote. This is a [HITL](../../GLOSSARY.md) boundary shared
   with [M7](../M7-pr-lifecycle-review/), enforced by configuration and by the
   [`reference/promote-safety/`](reference/promote-safety/) lint, which fails a
   production deploy that auto-fires, ships a mutable ref, or looks its commit
   up again by name.
6. **Ephemeral preview environments** — each PR (and each verification run) can
   spin up its own disposable copy of the app on its own URL, torn down when the
   PR closes. Cheap and throwaway by design: a broken one is deleted, not
   debugged. Reviewers click a link instead of imagining the behavior.
7. **A test-data factory** — a programmatic way to seed a known, realistic
   dataset on demand, give every run (or preview environment) its own isolated
   tenant so runs can't corrupt each other, and reset to the known state in one
   command. Seeded + tenant-isolated + resettable is the contract; without it,
   "realistic" tests are flaky and fixtures rot. Values a test builds in its
   own process are a different tool,
   [M14](../M14-testing-strategy/README.md)'s typed test-data builders; M14
   also says which test tiers run per change and which on a schedule.
8. **Promotion execution** — the promotion itself ships what its gates
   approved, and proves it did: see [Promotion execution](#promotion-execution).
9. **Environment hygiene** — every resource the pipeline creates (a preview
   deployment, an ephemeral environment, a test tenant, a per-worktree data
   namespace) has an owner-keyed [reaper](../../GLOSSARY.md) that reads an
   expiry set at creation; the [promotion gap](../../GLOSSARY.md) between
   two environments is computed from git ancestry by
   [`reference/promotion-gap/`](reference/promotion-gap/); and a check
   against a deliberately-behind environment confirms its
   [currency](../../GLOSSARY.md) first: see
   [Environment hygiene](#environment-hygiene).

## External preconditions

A green build cannot establish that a service identity can read its secrets,
that a certificate still matches its pin, or that a bot can write a protected
branch. Those are [external preconditions](../../GLOSSARY.md): facts the
pipeline depends on but does not contain.

Declare **what must be true**, with an owner and a recovery action, in a
repository registry. Never record a dated inventory of what was true. Check
it on a schedule against the live system, read-only, under the identity the
real consumer uses. An administrator's successful read does not prove that
a workflow's identity has access. Check an identity end to end: a user that
exists but cannot authenticate, or a secret that exists but cannot be read,
does not satisfy the precondition.

A checker that cannot read the live state fails. Report **absent** separately
from **denied**; where a provider hides existence from an unauthorized caller,
report the uncertainty instead of claiming absence. A kind whose checker has
not landed is **pending**, never green. A deliberate exception names its
reason, approver and expiry; an expired waiver fails even if the underlying
condition now holds, so the stale exception must leave the registry. A valid
waiver remains visibly waived and cannot hide an unreadable or pending check.

The [registry template](templates/external-preconditions.yaml) and
[reference runner](reference/external-preconditions/) provide this contract.
The first kind checks branch protection, including classic rules and
rulesets together. Expected protection for a bot-written branch must permit
the named bot to bypass a pull-request requirement; every applicable live
rule must admit its write. A bypass in one ruleset cannot cancel a blocker
in another. A bypass that also lets the bot force-push or delete a branch
fails when the expected state forbids those operations for it.

The report maintains one current tracker issue for the registry through
[M11's reconciliation rule](../M11-process-observability/README.md#one-current-issue-for-external-preconditions).
Live checks never repair host settings. A person reviews and applies the
recovery action; the next observation proves whether it worked.

## The watchdog decides by cause

A pointer that lags is a symptom with several causes, and each wants a
different response. A threshold on the lag ("more than 20 commits, or older
than a day") can only page, and it pages for the wrong things: a tip that
changes only documentation, a verification that correctly failed. People
learn to ignore the page, and the one time it matters, nobody looks. So the
watchdog decides by cause, under these rules.

- **Lag counts only [code-bearing](../../GLOSSARY.md) changes.** The pointer
  lags when the range from it to the tip changes a path verification builds
  or tests. A tip that
  changes only documentation legitimately leaves the pointer behind: nothing
  about it needs verifying.
- **Decide by cause, and heal exactly one.** For a tip with code ahead, the
  state of its verification decides. A run queued or in progress is latency:
  fine. A run that failed is the gates holding the pointer back: fine, and no
  heal, since running them again changes nothing until the tip changes. A run
  that succeeded while the pointer stayed is a skipped or broken advance
  step: it fails for a person to look at and is never re-run, because
  re-running reproduces the skip. No conclusive run past a grace window is a
  [dropped trigger](../../GLOSSARY.md): the push never became a run, or the
  run ended without a verdict (cancelled, timed out, never started). The
  watchdog heals it by dispatching verification at the tip. That is the only
  cause it heals, and only within a budget of attempts: when the runs it
  dispatched at the same tip keep ending without a verdict, another dispatch
  would only repeat them on every scheduled observation, so past the budget
  it stops healing and fails for a person. Every other failure is a fact for
  a person.
- **A queue stall is a failure.** A job's timeout counts no time spent
  waiting for a runner, so a run no runner picks up holds its serialized slot
  indefinitely, and every newer run waits behind it while everything reads
  as latency. The watchdog bounds that wait, cancels the run that holds the
  slot and fails loudly: the cancel frees the slot, and the missing runner is
  a capacity fault only a person can repair. The cancel bypasses no
  gate, because the next run covers the whole range (below). This is
  [M13's bound](../M13-pipeline-economy/README.md#4-bound) applied to
  post-merge verification; M13's
  [queue-stall check](../M13-pipeline-economy/reference/queue-watchdog/)
  measures the same wait over every workflow, and its
  [supersede rule](../M13-pipeline-economy/README.md#3-supersede) says when a
  cancelled run is covered.
- **Divergence is a failure.** The pointer only ever fast-forwards, so a
  pointer that is not an ancestor of the integration branch can never advance
  again: something wrote a commit to it that the branch lacks. The watchdog
  fails and names the recovery: contain first (until shown otherwise, a
  divergence is a leaked writer credential or a broken workflow), then a
  [back-merge](../../GLOSSARY.md), a commit on the integration branch with
  the branch's own tree and the pointer's tip as its second parent, which
  restores ancestry without merging the diverged content. Never force the
  pointer back: its protection exists to forbid that write, and a pointer
  that jumps backwards makes the deploy that follows it ship something older
  than what runs.
- **Verification covers the whole gap.** Every verification run diffs the
  whole range from the pointer to the tip, never the tip against its parent.
  Only then is it safe for the verification queue to keep one pending run
  per branch and drop the runs it supersedes, for the watchdog to cancel a
  stalled run, and for a heal dispatched at the tip to cover a dropped push
  behind a documentation-only commit. A tip-only diff loses a superseded
  push's changes without a trace: a push that renames a database column
  queues behind the run in progress, a typo fix lands on top of it and takes
  its place in the queue, and the surviving run, diffed against its parent,
  sees the typo and never the rename. A dispatch from another branch covers
  nothing of the integration branch's queue, so it gets a slot of its own.

[`reference/verified-pointer/`](reference/verified-pointer/) makes the rules
mechanical: it takes the observation (ancestry, code ahead, the tip's
verification state and age, the longest runner wait, the heals already
dispatched at the tip) and gives two verdicts
the workflow branches on, `queue=` and `pointer=`. The recipes that collect
the observation per provider are in
[mappings.md](mappings.md#the-verified-pointer-watchdog). A watchdog
scheduled onto the runner pool it watches stalls with it: give it another
pool.

## Promotion execution

A gated, manual promotion can still ship the wrong thing. The gate checks one
commit; a later job fetches the branch again and gets a newer one. Staging
verified one build; production gets a rebuild with different bytes. The
deploy command returns success; the cluster is still running the old version.
Two promotions start a minute apart; one of them is silently dropped, or both
migrate the same database at once. Each of these passes every check described
so far. The invariants below close them.

### The gated commit is the shipped commit

- **Pass the commit, never look it up again.** The first job of a promotion
  resolves the `verified` pointer once and outputs the commit it checked.
  Every later job (migrate, deploy, verify) takes that commit from the
  upstream job's output. A job that fetches a branch by name, the pointer
  included, gets whatever the name points at when *that* job starts, and the
  pointer may have moved while the gate ran or while the run waited its turn.
  The [promote-safety lint](reference/promote-safety/)'s rule (c) fails a
  production deploy job that selects its commit by name.
- **One promotion per environment at a time, and none dropped.** Two
  promotions running together race each other's deploy and, worse, each
  other's database migration. Serialize them, but through a mechanism that
  queues every request: a mechanism that keeps only the newest pending run
  discards a request someone made on purpose, with different inputs, without
  telling anyone. Where the CI provider's own serialization drops pending
  runs, key it so it never does and add an explicit lock step that waits
  for every earlier promotion to finish before the first change is made.
  The lock refuses a re-run, which keeps its original place in that order
  and would pass as earliest while a later promotion is changing production
  (start a new promotion instead), and is checked again just before the step
  that cannot be undone, the migration
  ([mappings.md](mappings.md#promotion-execution) has the GitHub Actions
  form). GitLab's resource group is held per job, so it serializes a
  promotion only when it is held across the whole mutating sequence: on the
  one job, or trigger job, that runs it. On GitHub Actions a lock held for the
  whole mutating section would not depend on that order (see
  [Future](#future)).
- **Run the promotion from the [trusted ref](../../GLOSSARY.md).** A manually started workflow
  runs the copy of its own definition that lives on the branch the operator
  picks, so starting it from an old or unreviewed branch runs old or
  unreviewed gate code against production. Start promotions from the
  `verified` pointer, check the gate's own code out from it, and have the
  production environment admit only that ref, so a run started from any other
  branch cannot deploy. Instructions and defaults alone do not stop an
  operator from picking another branch.

### Build once

[Build once](../../GLOSSARY.md): what reaches production is byte-identical
to what verification approved: the same container image, the same bundle,
addressed by its [digest](../../GLOSSARY.md) (a hash of the content, such as
`image@sha256:…`), never by a tag that can be moved. Promotion copies or
re-tags that artifact; it never rebuilds it. That only works when nothing
environment-specific is compiled in, so per-environment settings (the API's
address, public keys, feature switches) are supplied at deploy time: a
runtime configuration file served beside a web app's bundle, environment
variables or a configuration object for a container. The artifact's own
identity (the commit it was built from) is the one value that stays compiled
in, because it describes the code, not the environment.

### Post-deploy identity

- **A deploy is done when the environment says so** (the
  [post-deploy identity check](../../GLOSSARY.md)). The deploy command
  returning, or a deployment tool reporting "synced", says the request was
  accepted, not that the new version runs. A deploy is complete only when the
  live environment reports the exact artifact identity that was promoted
  (the digest it runs), its rollouts are ready (every running copy of the
  new version, a replica, is up, and none of the old serves traffic), and a
  readiness check that exercises the application's critical dependencies
  passes (for an application with a database, one that queries it). Check the reported identity *before* waiting on
  rollout status: a wait started before the new version is applied reports
  the previous, already-finished rollout as success.
- **Read what actually deployed.** A deploy run that changed only some of its
  parts (the backend but not the web app) writes a manifest of what it
  actually deployed this run: each part, whether it deployed, and its
  identity. Anything downstream, such as an end-to-end run against the new
  environment, reads that manifest instead of assuming everything changed or
  guessing from the run's success.

### Release state off the source line

- **Release pointers stay pure fast-forwards of verified source.** A pointer
  that says "this is what production runs" (a `main` or `release` branch
  advanced only by promotion) only ever moves forward to a commit the
  `verified` pointer held, and only once the identity check has passed, so
  a failed render or rollout leaves it naming what production still runs.
  A promotion whose gated commit is older than the pointer is refused before
  it changes anything, checked against a freshly fetched pointer once the
  promotion holds the lock: a fast-forward-only merge of an older commit succeeds
  as a no-op, so check that the pointer is an ancestor of the gated commit,
  and that the pointer equals the gated commit after the merge. If the
  promotion also commits generated files to it, the pointer diverges from
  `verified`, and the next promotion cannot fast-forward.
- **Rendered deployment state lives on its own ref.** When deployment is
  driven from git ([GitOps](../../GLOSSARY.md): a controller makes the
  cluster match what a git ref holds), the rendered manifests for an
  environment (its [rendered state](../../GLOSSARY.md)) go to a dedicated
  ref holding nothing else. Only a dedicated machine identity, allowed to
  write that ref and nothing else, writes it. Its history is the record of
  what was deployed, and rolling back means returning it to an earlier
  commit.
- **Branch protection must let that identity through.** A machine-written ref
  is advanced by a direct push, never by a pull request, so a rule that
  requires every change to arrive through a pull request blocks the writer,
  even when it requires zero approvals. Protect such a ref by restricting *who may push*
  to the one writer identity, and require no pull request on it; where a
  pull-request rule must stay, give the writer an explicit bypass. A
  release step that commits a new version to the integration branch uses
  the same exception, narrowed further; that branch is then not a release
  pointer, and [M16](../M16-releases-versions/README.md#core-pieces) says
  how the two stay apart.

## Environment hygiene

The environment kit creates things: a preview deployment per pull request,
an ephemeral environment per verification run, a tenant per test run, a
database namespace per worktree, a process a test started. Each is cheap to
create and, left alone, stays forever. The failures are slow and then sudden:
a host that stops publishing once a project holds too many stale
deployments turns a missing reaper into a deploy outage; a shared database
fills with the schemas of branches deleted months ago; a scheduled check
pages every night about an environment that is behind on purpose. The
rules below keep the kit honest.

### Every created resource has a reaper

- **Teardown is symmetric with creation.** Whatever creates a resource
  writes, at creation, who owns it and when it expires (a label on the
  namespace, a comment on the schema, a row in a registry), and a reaper
  keyed to that owner runs on a schedule and removes what has expired or lost
  its creator. The reaper is decided when the create step is written, not
  when the platform fills up. Preview deployments are kept by count per
  project (the newest N, the rest deleted oldest first); ephemeral
  environments by the expiry their spawner wrote; per-worktree namespaces by
  owner and expiry
  ([M12's reference](../M12-parallel-agent-ergonomics/reference/worktree-namespace/)
  decides which to drop); processes and scratch directories a test started
  by the test runner's own scope, which removes them when the process ends.
- **Report first, act on opt-in, refuse production.** A destructive reaper's
  default is a report of what it would remove. It acts only when a
  repository variable or a dispatch input says so, never because it merged:
  a destructive scheduled job that goes live on merge removes something the
  day its first bug ships. It refuses the production environment or
  namespace outright, at every layer it has (the operator's command, the
  rendered job, the target the job reads from its own environment), so no
  combination of inputs reaches production. A reaper that cannot read what
  it would reap (a failed listing, a denied credential) fails rather than
  reading the failure as nothing to do.
- **One owner's reaper touches only that owner's resources.** Two owners'
  reapers then never race, and a resource created without an owner or an
  expiry is reported as unlabelled, never reaped: the missing key is the
  finding.

### The promotion gap comes from ancestry

Which changes have reached which environment is the range between the
environments' pointers: the commits in `production..verified` are what
waits for the next promotion, and the work items they name in their
subjects and trailers are the [promotion gap](../../GLOSSARY.md).
[`reference/promotion-gap/`](reference/promotion-gap/) reads it. It is
never kept by hand in tracker fields ("deployed to staging"): a field holds
only while every promotion remembers to move every item, and a pointer that
moved by itself (a deploy, a back-merge) moves no field. The report runs on
a schedule and on every push to a pointer branch, publishes where the team
reads (the run's summary, an artifact, a pinned document), and its count per
environment pair is a metric in
[M11](../M11-process-observability/README.md)'s registry. When the later
environment's pointer (production) is not an ancestor of the earlier one's
(verified) the gap is not a range, and the
report refuses to decide: the
[divergence rule](#the-watchdog-decides-by-cause) applies.

### A check confirms the environment's currency first

An environment that is deliberately behind (a demo promoted by hand, a
staging that waits for a window) runs an older version than the integration
branch. A scheduled check that calls into it (a janitor, a smoke test, a
contract test) depends on routes, schemas and behaviour that landed at
particular commits; run against an older build it reports red for staleness
that is no defect, and after enough red nobody reads it. So a currency step
decides, once, before the check's cells are built, whether the environment
runs a version the check applies to:

- **The floor is derived, never declared.** The oldest version the check
  applies to is the newest commit touching any path the check depends on,
  read from history. A minimum version kept by hand stops moving the day
  someone changes a dependency without updating it, and from then on it
  reports current for an environment that is not.
- **Ancestry decides.** The deployed version is read from the environment's
  own pin (the commit its manifest names, the identity its build reports),
  and the environment is current when the floor is an ancestor of it.
- **A non-current cell is removed, not skipped.** The currency step emits
  the list of environments to check, and the matrix is built from it; a
  skipped cell still reports a status, and a status that is neither red nor
  green is read as green. No cell means no status, which is the honest
  answer.
- **It fails closed, without taking the rest down.** An unreadable pin, a
  dependency path that no longer exists, a git lookup that fails: each
  counts the environment as stale and drops its cell. The check's other
  cells still run when the currency step itself fails for reasons of its
  own (a checkout that timed out), so an infrastructure failure of one
  environment's step does not silence another's.

[mappings.md](mappings.md#environment-hygiene) wires each per provider:
the reaper's opt-in and its keep-newest sweep, the gap report's triggers, and
the currency step's matrix.

## Maturity levels

- **Lite** — the environments and the deploy path are **written down** (a deploy
  runbook exists, environments are named and described), and PR gates run on
  every pull request. Enforcement may be convention; the verify/deploy split may
  still be informal.
- **Standard** — CI **separates PR gates from post-merge verification**; a
  `verified` pointer advances only on passing verification (mechanically, in CI);
  production deploys ship only verified artifacts, with the gated commit passed
  from job to job; artifacts are built once and promoted by digest; the
  watchdog runs on a schedule, counting only code-bearing lag; every
  resource the pipeline creates has a scheduled, owner-keyed reaper that
  reports by default; the promotion gap is computed from ancestry on a
  schedule; and a page that lists the pipelines, where one is kept, is
  generated or checked, never hand-kept; external preconditions are declared
  and checked live under their consuming identities, with expiring waivers.
- **Strict** — the verified-pointer watchdog and the promote-safety lint
  both run in [CI](../../GLOSSARY.md) with their self-tests; the watchdog
  decides by cause, heals only a dropped trigger and within a budget of
  attempts, bounds the runner queue and
  fails on divergence, and verification covers the whole unverified range;
  promotion to
  production is manual and gated by an **environment protection rule** so it
  cannot auto-fire (mechanical), runs from the trusted ref, one at a time
  without dropping a request; a deploy completes only on the live identity
  check; release state is kept off the source line; ephemeral preview
  environments plus a resettable, seeded, tenant-isolated test-data factory
  exist; and a check against a deliberately-behind environment confirms its
  currency first and drops the cell otherwise.

Deploy-shaped criteria are **expected-absent for a library-shaped repo**: a
published package has no environments, no `verified`-to-production path, and no
preview environments to spin up. Its path to its users is a release in
versions, which [M16](../M16-releases-versions/README.md) covers: a changelog
per released artifact, the version chosen after the merge, a tag only on
verified code. Such a repo can satisfy this module at Lite (document that it
does not deploy) without the Standard/Strict deploy machinery counting against
it; the [audit](../../plugin/skills/audit/README.md) calibrates by repo shape.
A repository that both deploys and publishes follows both modules.

## Adoption steps

1. Copy [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) into your
   docs tree and adjust the tool names; use
   [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml) as the
   spine when you split your CI into the four stages.
2. Introduce the **`verified` pointer**: add a post-merge verification workflow
   that advances a `verified` branch/tag only on success, and point your deploy
   jobs at it instead of at a branch.
3. Make verification diff the whole `verified..tip` range and accept a
   manual dispatch, then add the watchdog
   ([`reference/verified-pointer/`](reference/verified-pointer/)) as a
   scheduled job on another runner pool: it dispatches verification on a
   dropped trigger within its heal budget, cancels a run stalled in the
   runner queue, and fails on the faults a person must repair (an exhausted
   heal budget, a pointer that did not move after a success, a stalled queue,
   divergence, an observation it cannot read); wire the failure to your
   pager.
4. Gate production behind a manual trigger + environment protection rule, and add
   the [`reference/promote-safety/`](reference/promote-safety/) lint over your
   deploy workflows so the gating can't regress.
5. Make the promotion execute what it gated
   ([Promotion execution](#promotion-execution)): output the gated commit from
   the first job and pass it on, promote artifacts by digest with settings
   supplied at deploy time, serialize promotions without dropping one, end
   every deploy with the identity check, and move rendered deployment state
   to its own ref (recipes in [mappings.md](mappings.md#promotion-execution)).
6. Stand up disposable preview environments per PR and a seeded, tenant-isolated,
   resettable test-data factory (platform options in [mappings.md](mappings.md)).
7. Keep the kit clean ([Environment hygiene](#environment-hygiene)): give
   every create step its owner-keyed, report-first reaper; run
   [`reference/promotion-gap/`](reference/promotion-gap/) on a schedule and
   on every pointer move, and register its count as a metric; and put a
   currency step in front of any check that runs against an environment
   that is deliberately behind.

## Status

### Runnable form

Jig's [plugin](../../plugin/README.md) carries the
[`github-actions`](../../plugin/skills/github-actions/SKILL.md) skill, which
reviews a change to a repository's workflows against its documented CI
architecture; [`CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) is the shape
it recognises when the repository names no document of its own
(`github_actions.conventions_doc`).

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) | The copyable four-stage contract (PR gates, post-merge verification, deploy, promotion), with the preview-environment and test-data-factory contracts, and the rule for a [pipeline index](../../GLOSSARY.md): derived or gated, never hand-kept |
| [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml) | A provider-neutral spine of the four stages |
| [`reference/verified-pointer/`](reference/verified-pointer/) | The watchdog: decides why the `verified` pointer lags (nothing to verify, verifying, blocked, within grace, a dropped trigger to heal, heals exhausted, ran but stale, diverged) and whether a verification run is stalled waiting for a runner; or, from two numbers, whether the pointer lags at all |
| [`reference/promote-safety/`](reference/promote-safety/) | The lint that fails a production deploy that can fire on its own, ships a mutable ref, or looks its commit up again by name |
| [`reference/promotion-gap/`](reference/promotion-gap/) | The promotion gap report: the work items the commits between two environment pointers name, from git ancestry, with a bound and a JSON form for the metric |
| [`mappings.md`](mappings.md) | CI providers, preview-environment platforms, promotion gates, the promotion-execution recipes (digest pinning, runtime configuration, GitOps tools, serialization, rollout and identity checks), and the environment-hygiene wiring (reapers per resource, the gap report's triggers, the currency matrix) |
| [maturity criteria](../../plugin/skills/audit/criteria/M10-environments-deploy.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference gate is a Bun script with a self-test and fixtures; the
watchdog and the promotion-gap report import the repository's `lib/`
helpers, so each runs from a pinned Jig checkout or with `lib/` vendored
beside it.

### Left out by design

- **A preview-environment spawner and a test-data factory.** Both are product-
  and infrastructure-specific code (a particular host, database and tenant
  model), not a portable mechanism. The module gives their *contracts*
  (disposable environments; seeded, tenant-isolated, resettable data) and
  catalogues platform options in [mappings.md](mappings.md); the
  implementation belongs to each repository's stack.
- **Delivery telemetry.** Gate-pass dashboards and deploy metrics belong with
  [M11](../M11-process-observability/).
- **Where each suite runs, and what it costs.** Per change, after merge, on
  a schedule or on demand is decided by
  [M13 pipeline economy](../M13-pipeline-economy/README.md#6-place)'s
  placement table, which this module's verified pointer feeds: a suite runs
  after merge when the pointer waits for it.
- **A reaper per platform, and a currency script.** A reaper's drop is a
  call into one host's or database's API, and a currency step's dependency
  paths are one check's own, so the module states the rules, gives the
  decisions that are portable (which namespaces to drop, which items wait)
  and catalogues the per-platform forms in
  [mappings.md](mappings.md#environment-hygiene).
- **A rollout-assertion script.** The post-deploy identity check depends on
  the platform (a Kubernetes cluster, a serverless host, a static-file host),
  so the module states its conditions and their order, and
  [mappings.md](mappings.md#post-deploy-identity) gives the commands per
  platform.

### Future

- **A recovery script for a diverged pointer.** The watchdog names the
  back-merge; a script that plans it (which commits diverged, whether any
  reached production), opens it as a pull request once the operator confirms
  containment, and merges it only as a merge commit pinned to that head, is
  validated in a working repository and not yet brought here.
- **A held promotion lock.** The lock step described above waits until its
  run is the earliest active promotion, refuses re-runs and re-checks before
  the migration, so it depends on run ids rising with each new promotion. A
  lock held for the whole mutating section, or a durable queue, would not
  depend on that order, and is not yet proven in a working repository.
- **Verifying what runs at admission.** Signing the promoted artifact and
  having the platform refuse anything unsigned (image signatures checked at
  admission, signed commits required on the rendered-state ref) would prove
  the digest that runs is the one verified. It is not yet validated in a
  working repository.
