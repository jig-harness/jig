# M10 mappings — per-ecosystem implementations

The module [invariant](README.md) — four stages, an explicit `verified` pointer,
a freshness watchdog, verified-only deploys, and a manual gated promotion — is
tool-independent. This file maps its mechanisms onto concrete
[CI](../../GLOSSARY.md) providers, preview-environment platforms, and promotion
gates. Replace `<placeholders>` with your values. Install the pinned Bun runtime
before the commands below; the module gates and tests require Bun.

## The two gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| Promote-safety lint | pre-commit over the deploy workflows (optional) | blocking on any PR that touches the deploy workflows — the workflows are the thing checked |
| Verified-pointer freshness | n/a (needs live pointer state) | scheduled watchdog job; fails to page/heal when the pointer lags |

The freshness watchdog is a *scheduled* job, not a per-PR gate — it watches a
background process (verification keeping up), not a diff, exactly as
[M8](../M8-learning-loop/)'s parity report is scheduled rather than per-PR.

One thing the promote-safety example must get right and you must not drop:

- **Run the lint from the BASE, not the PR checkout.** A merge-blocking lint that
  runs out of the PR's own checkout is not a gate — the PR can edit the script
  (or the workflow) to report success. Check the PR's tree out as *data* to be
  scanned, and run the gate script from a separately checked-out base tree the PR
  cannot alter (or a pinned reusable workflow). Set one `M10` variable to wherever
  you vendored the module and build every path from it. This is the same
  base-not-head discipline as [M7](../M7-pr-lifecycle-review/)'s reviewer lint.

### GitHub Actions

```yaml
# .github/workflows/deploy-safety.yml — lints the deploy workflows on every PR
on:
  pull_request:
    paths: [".github/workflows/**"]
jobs:
  promote-safety:
    runs-on: ubuntu-latest
    env:
      M10: base/modules/M10-environments-deploy    # gate scripts, from the base tree
    steps:
      - uses: actions/checkout@<full-commit-sha>    # v4; PR tree — scanned as DATA
        with: { path: pr }
      - uses: actions/checkout@<full-commit-sha>    # v4; BASE tree — owns the gate
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - name: Production deploys are gated + verified-only (blocking)
        run: WORKFLOWS_DIR=pr/.github/workflows bun "$M10"/reference/promote-safety/check-promote-safety.ts
      - name: Gate self-tests (blocking)
        run: |
          bun test "$M10"/reference/promote-safety/check-promote-safety.test.ts
          bun test "$M10"/reference/verified-pointer/check-verified-fresh.test.ts
---
# .github/workflows/verified-watchdog.yml — scheduled freshness watchdog
on:
  schedule: [{ cron: "*/15 * * * *" }]
jobs:
  watchdog:
    runs-on: ubuntu-latest
    env:
      M10: modules/M10-environments-deploy      # where you vendored the module
      MAX_BEHIND: "20"
      MAX_AGE_SECONDS: "86400"
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { fetch-depth: 0 }                    # need history to measure lag
      - name: verified pointer is fresh (page/heal on fail)
        run: |
          git fetch --force origin "refs/tags/verified:refs/tags/verified" "$GITHUB_REF_NAME"
          BEHIND=$(git rev-list --count verified..origin/${GITHUB_REF_NAME})
          OLDEST=$(git log --reverse --format=%ct verified..origin/${GITHUB_REF_NAME} | head -n 1)
          NOW=$(date +%s); AGE_SECONDS=$(( NOW - ${OLDEST:-$NOW} ))
          BEHIND="$BEHIND" AGE_SECONDS="$AGE_SECONDS" \
            bun "$M10"/reference/verified-pointer/check-verified-fresh.ts
```

### GitLab CI

```yaml
promote_safety:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]
  variables:
    # Gate scripts MUST come from the BASE the MR targets, never the MR's own
    # tree — a fork MR can edit its own copy of the gate to report success.
    # Extract the base copy of the module and point M10 at THAT; the MR's
    # workflow files are scanned only as data.
    M10: base/modules/M10-environments-deploy
  before_script:
    - git fetch --depth=1 origin "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
    - mkdir -p base && git archive "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
        modules/M10-environments-deploy | tar -x -C base
  script:
    # scan the MR's own deploy workflows (data) with the trusted base-tree gate
    - WORKFLOWS_DIR=.gitlab/deploy bun "$M10"/reference/promote-safety/check-promote-safety.ts
    - bun test "$M10"/reference/promote-safety/check-promote-safety.test.ts
    - bun test "$M10"/reference/verified-pointer/check-verified-fresh.test.ts

verified_watchdog:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]
  variables:
    M10: modules/M10-environments-deploy        # where you vendored the module
    MAX_BEHIND: "20"
    MAX_AGE_SECONDS: "86400"
  script:
    - BEHIND=$(git rev-list --count verified..origin/$CI_DEFAULT_BRANCH)
    - OLDEST=$(git log --reverse --format=%ct verified..origin/$CI_DEFAULT_BRANCH | head -n 1)
    - NOW=$(date +%s); AGE_SECONDS=$(( NOW - ${OLDEST:-$NOW} ))
    - BEHIND="$BEHIND" AGE_SECONDS="$AGE_SECONDS"
        bun "$M10"/reference/verified-pointer/check-verified-fresh.ts
```

## CI providers — the four stages + the `verified` pointer

Any provider works; the four stages are just workflows keyed on different
triggers, and the `verified` pointer is a plain git ref (a branch or tag) the
verify stage advances and the deploy stage reads.

| Provider | Stage 1 (PR gates) | Stage 2 (verify → advance pointer) | Stages 3–4 (deploy / promote gate) |
|----------|--------------------|-------------------------------------|-------------------------------------|
| GitHub Actions | `on: pull_request` | `on: push` to default branch; final step force-updates `refs/tags/verified` | deploy job on `verified` update; `environment:` with required reviewers gates prod |
| GitLab CI | merge-request pipeline | default-branch pipeline; final job moves the `verified` ref | manual (`when: manual`) job in a protected `environment:` |
| Jenkins / Buildkite / `CircleCI` / others | per-PR pipeline | default-branch pipeline advancing a `verified` tag | manual approval step + protected deploy credentials for prod |

The pointer is deliberately a **git ref**, not a database row: it is inspectable
(`git log verified`), diffable, and survives a CI outage. Advance it with a
force-update of a tag (`git tag -f verified <sha> && git push --force origin
verified`) or a fast-forward of a `verified` branch.

## Preview-environment platforms (options)

Disposable per-PR environments. Any of these is one option among several — pick
by where your app already runs; none is required.

| Option | Fit |
|--------|-----|
| Vercel / Netlify / Cloudflare Pages preview deploys | frontend / static / edge apps — a preview URL per PR out of the box |
| Render / Railway / Heroku review apps | full-stack apps with a managed backend + database branch per PR |
| Fly.io / a Kubernetes namespace-per-PR / Argo CD `ApplicationSet` | container apps where you want the preview on the same platform as prod |
| A platform-as-a-service ephemeral environment (self-hosted spawner) | when you already run the infra and want the preview identical to prod |

Whatever the platform, keep the two properties: created on PR open and
**destroyed on PR close** (cattle, not pets), and seeded by the test-data factory
so the preview has realistic data.

## Test-data factory (options)

The contract is seeded + tenant-isolated + resettable; the implementation is
yours. Common building blocks:

| Concern | Options |
|---------|---------|
| Seed | a seed script / factory library (per-language: factory-bot-style builders, fixtures loaders) invoked with a target tenant id |
| Tenant isolation | a schema/namespace per run, a per-PR database branch, or a tenant/org column scoped per environment |
| Reset | transaction rollback per test, a snapshot restore, or a `factory reset --tenant <id>` command that truncates + reseeds |

Keep it a *factory* (programmatic, on-demand), not a checked-in dump: a static
snapshot drifts and becomes another [generated artifact](../../GLOSSARY.md) to
keep fresh.

## Promotion gates (environment protection / manual approval)

Stage 4 must be a human action that cannot auto-fire. The gate is a platform
setting, not a script — the [promote-safety lint](reference/promote-safety/)
checks that the *wiring* (a manual trigger or an `environment:` reference)
exists; the protection rule itself lives in provider config.

| Provider | Manual-gate mechanism |
|----------|------------------------|
| GitHub | a deployment `environment` with **required reviewers** and/or a wait timer; `workflow_dispatch` for the trigger |
| GitLab | a protected `environment` + a `when: manual` job; deploy freezes / approval rules |
| Others (Jenkins / Buildkite / Argo CD) | a manual approval / `block` step, protected prod credentials, or a sync gate requiring sign-off |

The human checkpoint (**promote to production**) is enforced by these settings
plus the [HITL](../../GLOSSARY.md) boundary shared with
[M7](../M7-pr-lifecycle-review/) — a bot must not hold it.
