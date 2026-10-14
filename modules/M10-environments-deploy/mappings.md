# M10 mappings — per-ecosystem implementations

The module [invariant](README.md) — four stages, an explicit `verified` pointer,
a freshness watchdog, verified-only deploys, a manual gated promotion that
ships what it gated — is tool-independent. This file maps its mechanisms onto
concrete [CI](../../GLOSSARY.md) providers, preview-environment platforms,
promotion gates, and the promotion-execution tools (registries,
[GitOps](../../GLOSSARY.md) controllers, rollout checks). Replace `<placeholders>` with your values. Install the pinned Bun runtime
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

## Promotion execution

The [promotion-execution invariants](README.md#promotion-execution) — the gated
commit is the shipped commit, [build once](../../GLOSSARY.md), post-deploy identity, release state
off the source line — map onto these mechanisms.

### Pass the gated commit from job to job

| Provider | First job resolves and outputs | Later jobs take it |
|----------|--------------------------------|--------------------|
| GitHub Actions | `outputs: { sha: ${{ steps.pin.outputs.sha }} }`, with `echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"` after checking out the pointer | `needs: gate` and `ref: ${{ needs.gate.outputs.sha }}` in `actions/checkout`; the same expression in every command that names the commit |
| GitLab CI | write `GATED_SHA=<sha>` to a dotenv file (plain `NAME=value` lines GitLab turns into variables of later jobs) declared as `artifacts: reports: dotenv:` | `needs: [gate]`; the variable `$GATED_SHA` is set in the later job |
| Others | a pipeline output or artifact holding the commit | read it; never `git fetch origin <branch>` again |

```yaml
# GitHub Actions — the shape the promote-safety lint's rule (c) accepts
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      sha: ${{ steps.pin.outputs.sha }}
    steps:
      - uses: actions/checkout@<full-commit-sha>   # v4
        with: { ref: verified, persist-credentials: false }   # gate code from the trusted ref
      - id: pin
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - run: ./gates/check-promotion.sh            # runs the copy checked out above
  deploy-production:
    needs: gate
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha>   # v4
        with: { ref: "${{ needs.gate.outputs.sha }}" }
      - run: ./deploy --target production --commit "${{ needs.gate.outputs.sha }}"
```

### Run from the trusted ref

The [trusted ref](../../GLOSSARY.md) is the `verified` pointer. A GitHub `workflow_dispatch` run executes the workflow file as it is on the
ref chosen in "Use workflow from" (or `gh workflow run <file> --ref <ref>`);
the default is the default branch. Dispatch promotions with
`--ref verified`, and make that the default of any script or skill that
starts one. Check the gate's code out from `verified` explicitly (as above),
never from `github.ref`. GitLab runs a manual job from the pipeline it belongs
to, so start the promotion from a pipeline on the trusted ref.

A default is not enforcement: an operator can still pick another branch.
Make the platform refuse it:

| Provider | Only the trusted ref reaches production |
|----------|------------------------------------------|
| GitHub Actions | the production environment's **deployment branches and tags** rule set to selected refs, listing only `verified` (a tag rule when the pointer is a tag); a job naming the environment from any other ref fails before it runs |
| GitLab CI | protected variables alone do not restrict the ref: every pipeline on any protected ref (a protected `main` too) receives them. Make `verified` a protected tag or branch and release production's credentials only to it, for example through an ID token (`id_tokens:`) whose cloud-side trust policy admits only the claims `ref` = `verified`, `ref_protected` = `true` and `environment` = `production`; a protected environment limits who may deploy |

### Serialize promotions without dropping one

| Provider | Built-in serialization | What it does to a waiting request | Use |
|----------|------------------------|-----------------------------------|-----|
| GitHub Actions | `concurrency: { group: <key>, cancel-in-progress: false }` | at most one run and **one pending** run per group: a newer pending run cancels the older pending one, whatever its inputs | key the group per run (`group: promote-production-${{ github.run_id }}`) so none is dropped, and serialize with a lock job before the first change: it lists the workflow's active runs, one query per active `status` (`queued`, `in_progress`, `waiting` for an environment approval, `requested`, `pending`), each read in full (`gh api --paginate "repos/<owner>/<repo>/actions/workflows/<file>/runs?status=<status>&per_page=100"`; a single page holds only the newest 30), and proceeds once its own run id is the smallest; a failed query, or a list that does not contain its own run, fails the job rather than proceeding. It also fails a re-run (`github.run_attempt` above 1): a re-run keeps its original, lower run id, so it would count itself earliest while a later promotion is changing production; start a new promotion instead. Repeat the check (fail, don't wait) just before the migration |
| GitLab CI | `resource_group: production` | jobs in the group queue and run one at a time; the process mode `oldest_first` runs them in pipeline order (set through the Resource Groups API, `PUT /projects/:id/resource_groups/:key` with `process_mode=oldest_first`, not in `.gitlab-ci.yml`). The group is held per job: between two jobs of one promotion, a job of another promotion can take it | hold the group across the whole mutating sequence, never on each job separately: put it on the one job that runs every step changing production (migration through the identity check), or on a trigger job (`trigger:` with `strategy: depend`) that runs those steps as a downstream pipeline, which keeps the group until that pipeline finishes; set the process mode to `oldest_first` |
| Argo CD / Flux | one controller reconciles one target | the newest commit on the target ref wins | serialize the *writes* to the release-state ref (above), not the sync |

### Build once, promote by digest

| Concern | Mechanism |
|---------|-----------|
| Address by [digest](../../GLOSSARY.md) | a container image reference `<registry>/<name>@sha256:<64 hex>`; deployment manifests carry the digest, never a tag |
| Resolve a digest | `crane digest <ref>`, `skopeo inspect --format '{{.Digest}}' docker://<ref>`, `docker buildx imagetools inspect <ref>`, `gcloud artifacts docker images describe <ref> --format='value(image_summary.digest)'`, `aws ecr describe-images --query 'imageDetails[0].imageDigest'` |
| Promote without rebuilding | re-tag or copy the verified digest: `crane tag <ref>@<digest> production`, `crane copy`, `skopeo copy`, `gcloud artifacts docker tags add`, `aws ecr put-image` with the existing manifest |
| Reject a tag where a digest belongs | the code that renders deployment manifests refuses an image reference without `@sha256:`; a check over rendered manifests does the same |
| Web-app bundles | upload the verified bundle's bytes (a build artifact keyed by commit) to each environment's static host; do not run the build again at promotion |

**Runtime configuration.** A build tool that inlines environment values at
compile time (Vite's `import.meta.env`, webpack's `DefinePlugin`, Next.js's
`NEXT_PUBLIC_*`) makes every environment's bundle different. Move those values
to deploy time:

| Artifact | Per-environment settings supplied at deploy time |
|----------|--------------------------------------------------|
| Single-page web app | a small `env.js` per environment, loaded by `<script src="/env.js">` before the bundle, setting `window.__ENV__`; served uncached (`Cache-Control: no-store`, and a matching edge-cache rule on a content delivery network) while the content-hashed bundle files stay long-cached; a separate script file keeps a content security policy free of `unsafe-inline` |
| Container | environment variables, a Kubernetes `ConfigMap` / `Secret`, or a mounted config file; the image stays the same |
| Serverless function | the platform's environment configuration per stage |

Keep the build's own identity (its commit) compiled in: it says which code is
running, and error trackers group releases by it.

### GitOps and the release-state ref

| Tool | Reads | Production gate |
|------|-------|-----------------|
| Argo CD | an `Application`'s `spec.source.repoURL` + `targetRevision` (the release-state ref) + `path` | no `syncPolicy.automated` on production: an operator runs `argocd app sync <app>`; `argocd app wait <app> --sync --health` waits for it |
| Flux | a `GitRepository` (`spec.ref.branch`: the release-state ref) and a `Kustomization` or `HelmRelease` over it | the gated promotion is the only writer of the release-state ref, so publishing to it is the gate and the `Kustomization` may reconcile it automatically; or keep it `spec.suspend: true` and have the promotion run `flux resume kustomization <name>` (which applies and waits), then `flux suspend kustomization <name>` again. A `flux reconcile` alone is not a gate: an unsuspended `Kustomization` applies new revisions on its own, and a suspended one applies nothing until resumed |

**Rendered manifests on their own ref.** CI renders the environment's
manifests (Helm, Kustomize, cdk8s or another generator, to plain YAML with
image digests filled in) and commits them to a dedicated ref (for example a
`release-state` branch with no shared history with the source) that the
controller reads. The source line's release pointer then only ever
fast-forwards to the gated commit, once the identity check has passed.
`git merge --ff-only` of an older commit succeeds as a no-op, so refuse a
stale promotion before it changes anything with
`git merge-base --is-ancestor origin/<release-branch> "$GATED_SHA"`. Run it
once the promotion holds the lock, just before its first change, against a
freshly fetched pointer: an earlier promotion may have advanced the pointer
while this one waited. Confirm the result when advancing:
`git merge --ff-only "$GATED_SHA" && test "$(git rev-parse HEAD)" = "$GATED_SHA" && git push origin HEAD:<release-branch>`.

**One writer, and protection that admits it.**

| Forge | Writer identity | Protection on a machine-written ref |
|-------|-----------------|-------------------------------------|
| GitHub | a GitHub App installed on the one repository, its token minted inside the writing job only (`actions/create-github-app-token`) | classic protection: "Restrict who can push" listing that App, **no** "Require a pull request before merging" (with zero approvals it still blocks a direct push); rulesets: "Restrict updates" with the App on the bypass list, no pull-request rule; force pushes and deletion blocked |
| GitLab | a project access token or bot user | protected branch: "Allowed to push and merge" = that identity, "Allowed to merge" = no one |

A test over the workflow files can hold the identity's scope: the writer's
credential names appear in the writing job and in no other job or
workflow-level block.

### Post-deploy identity

The conditions, in this order, each under a deadline:

| Step | Kubernetes | Other platforms |
|------|------------|-----------------|
| 1. The live spec reports the promoted identity | poll `kubectl get deploy/<name> -o jsonpath='{.spec.template.spec.containers[0].image}'` until it equals `<image>@sha256:<digest>` and `.status.observedGeneration` ≥ `.metadata.generation`, failing once a deadline passes (for example 10 minutes); only then is step 2 about the new version | the platform's release or version endpoint reports the digest or commit (a static host's build-info file, a serverless function's version), polled under the same deadline |
| 2. Rollouts are ready | `kubectl rollout status deploy/<name> --timeout=10m`, then every running pod's `.status.containerStatuses[*].imageID` carries the digest; `argocd app wait --health` adds the controller's view | the platform's deployment status reaches its final ready state |
| 3. A readiness check of the critical dependencies passes | `curl -fsS --connect-timeout 5 --max-time 10 --retry 8 --retry-max-time 120 https://<host>/ready`, where `/ready` exercises what the application cannot serve without: for an application with a database, a query against it (a liveness check that answers without it does not count). `--retry` alone bounds attempts, not time: a server that accepts the connection and stalls holds the promotion until `--max-time` ends the attempt | the same endpoint; a static site's check fetches the deployed entry page and its runtime configuration file |

A permissions error reading the live state is a failure of the check, not a
reason to keep waiting: report it at once rather than letting it time out as
"not synced yet".

**A manifest of what deployed.** The deploy run uploads a small file (for
GitHub, `actions/upload-artifact` of a `deploy-manifest.json`) listing each
part it could deploy, whether it did this run, its identity and its rollout
result. A downstream workflow (`on: workflow_run`) downloads it with
`actions/download-artifact` with `run-id: ${{ github.event.workflow_run.id }}`
and `github-token` (another run's artifacts need a token, and the job needs
`permissions: actions: read`),
checks the triggering run's branch and event, and acts only on the parts that
deployed, validating any commit it reads before checking it out.
