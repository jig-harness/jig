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
> to production is a manual, gated human action** that cannot auto-fire. Preview
> environments are disposable and cheap; test data is seeded, tenant-isolated,
> and resettable.

Everything below is that one tool-independent statement made mechanical;
concrete per-provider wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **The four stages** — delivery is PR gates → post-merge verification →
   deploy → promotion, each with one job and a hard boundary to the next. Stage 2
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
   production deploy that auto-fires or ships a mutable ref.
6. **Ephemeral preview environments** — each PR (and each verification run) can
   spin up its own disposable copy of the app on its own URL, torn down when the
   PR closes. Cheap and throwaway by design: a broken one is deleted, not
   debugged. Reviewers click a link instead of imagining the behavior.
7. **A test-data factory** — a programmatic way to seed a known, realistic
   dataset on demand, give every run (or preview environment) its own isolated
   tenant so runs can't corrupt each other, and reset to the known state in one
   command. Seeded + tenant-isolated + resettable is the contract; without it,
   "realistic" tests are flaky and fixtures rot.

## Maturity levels

- **Lite** — the environments and the deploy path are **written down** (a deploy
  runbook exists, environments are named and described), and PR gates run on
  every pull request. Enforcement may be convention; the verify/deploy split may
  still be informal.
- **Standard** — CI **separates PR gates from post-merge verification**; a
  `verified` pointer advances only on passing verification (mechanically, in CI);
  production deploys ship only verified artifacts; and the freshness watchdog
  runs on a schedule.
- **Strict** — the verified-pointer freshness gate and the promote-safety lint
  both run in [CI](../../GLOSSARY.md) with their self-tests; promotion to
  production is manual and gated by an **environment protection rule** so it
  cannot auto-fire (mechanical); and ephemeral preview environments plus a
  resettable, seeded, tenant-isolated test-data factory exist.

Deploy-shaped criteria are **expected-absent for a library-shaped repo**: a
published package has no environments, no `verified`-to-production path, and no
preview environments to spin up — its "deploy" is a release/publish gated
elsewhere. Such a repo can satisfy this module at Lite (document that it does not
deploy) without the Standard/Strict deploy machinery counting against it; the
[audit](../../audit/) calibrates by repo shape.

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
5. Stand up disposable preview environments per PR and a seeded, tenant-isolated,
   resettable test-data factory (platform options in [mappings.md](mappings.md)).

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| Four-workflow CI/CD architecture (PR gates → verify → deploy → promote) | [`templates/CI-ARCHITECTURE.md`](templates/CI-ARCHITECTURE.md) + [`templates/pipeline.example.yaml`](templates/pipeline.example.yaml) — the contract and a provider-neutral spine |
| `verified` pointer + self-healing freshness watchdog | [`reference/verified-pointer/`](reference/verified-pointer/) — the watchdog as a mechanical gate + self-test + fixtures |
| Promotion/deploy safety (manual gate, verified-only) | [`reference/promote-safety/`](reference/promote-safety/) — the safe-wiring rule as a runnable lint + self-test + fixtures |
| Ephemeral preview-environment pattern + test-data-factory concept | contract prose in `CI-ARCHITECTURE.md`; platform options in [mappings.md](mappings.md) |

Also landed: [`mappings.md`](mappings.md) (CI providers, preview-environment
platforms, promotion gates) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): the reference
implementation's *concrete* preview-environment spawner and its test-data factory
are product- and infrastructure-specific code (a particular host, database, and
tenant model), not a portable mechanism — groundwork ports the **concepts and
their contracts** (disposable envs; seeded + tenant-isolated + resettable data)
and leaves the implementation to each repo's stack, with options catalogued in
`mappings.md`. The private acronyms for the two data-factory variants are
deliberately omitted (IP scrub); this module says "test-data factory." The
process-telemetry half of the reference implementation's environments-and-deploy
area (gate-pass dashboards, deploy metrics) belongs with
[M11](../M11-process-observability/), not here.
