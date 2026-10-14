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
> **`verified` pointer** (a branch or tag) only on success; a **freshness
> watchdog** fails loudly when that pointer lags, so a stalled verifier pages
> someone instead of silently shipping stale code; **deploys ship only what
> `verified` points at**, never a mutable branch or `:latest`; and **promotion
> to production is a manual, gated human action** that cannot auto-fire. A
> promotion **ships the exact commit and artifact its gates approved**,
> [built once](../../GLOSSARY.md) and passed from job to job, and is complete only when the live
> environment reports that identity. Preview environments are disposable and
> cheap; test data is seeded, tenant-isolated, and resettable.

Everything below is that one tool-independent statement made mechanical;
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
3. **The freshness watchdog** — a scheduled check on how far the pointer lags the
   default-branch tip (in commits and in time). If verification wedges, the
   pointer freezes silently; the watchdog makes that silence loud (page + heal).
   It is a [freshness gate](../../GLOSSARY.md) on a *pointer* rather than a file —
   the same move [M2](../M2-generated-artifact-freshness/) makes for generated
   files — and it ships as [`reference/verified-pointer/`](reference/verified-pointer/).
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
  pull-request rule must stay, give the writer an explicit bypass.

## Maturity levels

- **Lite** — the environments and the deploy path are **written down** (a deploy
  runbook exists, environments are named and described), and PR gates run on
  every pull request. Enforcement may be convention; the verify/deploy split may
  still be informal.
- **Standard** — CI **separates PR gates from post-merge verification**; a
  `verified` pointer advances only on passing verification (mechanically, in CI);
  production deploys ship only verified artifacts, with the gated commit passed
  from job to job; artifacts are built once and promoted by digest; and the
  freshness watchdog runs on a schedule.
- **Strict** — the verified-pointer freshness gate and the promote-safety lint
  both run in [CI](../../GLOSSARY.md) with their self-tests; promotion to
  production is manual and gated by an **environment protection rule** so it
  cannot auto-fire (mechanical), runs from the trusted ref, one at a time
  without dropping a request; a deploy completes only on the live identity
  check; release state is kept off the source line; and ephemeral preview
  environments plus a resettable, seeded, tenant-isolated test-data factory
  exist.

Deploy-shaped criteria are **expected-absent for a library-shaped repo**: a
published package has no environments, no `verified`-to-production path, and no
preview environments to spin up — its "deploy" is a release/publish gated
elsewhere. Such a repo can satisfy this module at Lite (document that it does not
deploy) without the Standard/Strict deploy machinery counting against it; the
[audit](../../plugin/skills/audit/README.md) calibrates by repo shape.

## Adoption steps

1. Copy [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) into your
   docs tree and adjust the tool names; use
   [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml) as the
   spine when you split your CI into the four stages.
2. Introduce the **`verified` pointer**: add a post-merge verification workflow
   that advances a `verified` branch/tag only on success, and point your deploy
   jobs at it instead of at a branch.
3. Add the freshness watchdog ([`reference/verified-pointer/`](reference/verified-pointer/))
   as a scheduled job; wire its failure to your pager and, ideally, to an
   automatic re-run of verification.
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
| [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) | The copyable four-stage contract (PR gates, post-merge verification, deploy, promotion), with the preview-environment and test-data-factory contracts |
| [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml) | A provider-neutral spine of the four stages |
| [`reference/verified-pointer/`](reference/verified-pointer/) | The freshness watchdog: fails when the `verified` pointer lags the default branch |
| [`reference/promote-safety/`](reference/promote-safety/) | The lint that fails a production deploy that can fire on its own, ships a mutable ref, or looks its commit up again by name |
| [`mappings.md`](mappings.md) | CI providers, preview-environment platforms, promotion gates, and the promotion-execution recipes (digest pinning, runtime configuration, GitOps tools, serialization, rollout and identity checks) |
| [maturity criteria](../../plugin/skills/audit/criteria/M10-environments-deploy.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference gate is a standalone Bun script with a self-test and fixtures.

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
- **A rollout-assertion script.** The post-deploy identity check depends on
  the platform (a Kubernetes cluster, a serverless host, a static-file host),
  so the module states its conditions and their order, and
  [mappings.md](mappings.md#post-deploy-identity) gives the commands per
  platform.

### Future

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
