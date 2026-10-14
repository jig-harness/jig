# M3 mappings — per-ecosystem implementations

The module [invariant](README.md) — one validated catalog, generated
projections, referenced by name — is tool-independent. This file maps its
consumer projections onto concrete [CI](../../GLOSSARY.md) providers, issue
trackers, and deploy systems. Replace `<placeholders>` with your repo's values.

## CI job selection (the primary consumer)

The resolver turns changed files into a set of affected areas; CI uses that
set to decide which jobs run. Two idioms:

| Approach | How | When |
|----------|-----|------|
| **Native path-filter** (static projection) | generate the provider's path-filter config from the catalog (each area's globs ∪ the globs of everything that transitively implies it); the provider decides per-job | simplest; no resolver at runtime; good when "affected = paths changed" is enough |
| **Resolver outputs** (dynamic projection) | run the resolver in a setup job, emit `area=true/false` outputs, and gate downstream jobs on them | needed when `impliedBy` closure matters (a shared-lib change must trigger app jobs whose own paths didn't change) |

### GitHub Actions

```yaml
# Dynamic: a setup job resolves areas, downstream jobs read its outputs.
jobs:
  resolve:
    runs-on: ubuntu-latest
    outputs:
      web-app: ${{ steps.r.outputs.web-app }}
      api-service: ${{ steps.r.outputs.api-service }}
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { fetch-depth: 0 }   # resolver needs the base..HEAD diff
      - id: r
        run: <your-resolver> --emit gha >> "$GITHUB_OUTPUT"
  build-web:
    needs: resolve
    if: needs.resolve.outputs.web-app == 'true'
    runs-on: ubuntu-latest
    steps: [ ... ]
```

```yaml
# Static: a generated dorny/paths-filter config (committed, freshness-gated).
# Regenerate from the catalog; a drift check (see M2) fails when it is stale.
- uses: dorny/paths-filter@<full-commit-sha> # v3
  id: filter
  with: { filters: .github/change-area-filters.yml }   # generated projection
```

### GitLab CI

```yaml
# Static projection -> rules:changes per job. Generate this block; gate freshness.
build-web:
  rules:
    - changes: ['apps/web-app/**', 'packages/core-lib/**']   # own ∪ implied paths
  script: [ ... ]
```

Any CI that can run a script can run the resolver and consume its outputs;
any CI with a path-filter primitive can consume the static projection. The
only provider-specific choices are the diff range the resolver reads
(`pull_request` base…HEAD, merge-commit parent union) and the outputs syntax.

## Issue trackers (label / flag projection)

Each area's `tracker.labels` and process-driving `tracker.flags` (see the
[flag-label](../../GLOSSARY.md) concept and [M9](../M9-tasks-memory/)) become
tracker labels/flags applied to the PR/issue — but not from the same
population: `labels` come from the *seeded* areas only (accuracy — a label
describes what changed), while `flags` come from the seeded areas'
`impliedBy` *closure* (a shared-library change must still trigger review of
its dependents), each flag decided per area rather than inherited as a side
effect of an unrelated `impliedBy` edge. See [§ Seeds vs.
closure](reference/catalog/README.md#seeds-vs-closure--which-side-each-projection-reads)
for the full rule.

| Tracker | Apply labels/flags |
|---------|-------------|
| GitHub | `gh pr edit --add-label` in a CI step, or `actions/labeler` fed the generated area→label map |
| GitLab | scoped labels via the API in a job, or `/label` quick-actions in an MR note |
| Linear / Jira | the tracker's API/automation, mapping *seed* area → label and *closure* area → flag; a `flag` label (e.g. `has-migration`) can trigger a mandatory review gate |

## Deploy tiers & post-deploy actions

`deployTier` groups areas into deploy lanes; `postDeploy` actions are collected
for the affected areas into a checklist the promote step runs. This is a data
projection — the deploy system stays generic:

| System | Consume the projection |
|--------|------------------------|
| GitHub Actions deploy workflow | read the resolved `deployTier`/`postDeploy` JSON to pick the environment and the post-deploy step |
| Argo / Flux / other GitOps | map `deployTier` to a sync wave or a target cluster; post-deploy actions as post-sync hooks |
| Manual runbook | render the post-deploy checklist (Markdown projection) into the release notes / PR body |

## Agent gate depth (`validation:`) wiring

The `validation:` field (see [`reference/catalog/README.md`](reference/catalog/README.md#agent-gate-depth-validation))
projects to the local hook layer, not CI job selection:

| Hook manager | Wire it |
|--------------|---------|
| lefthook / husky / pre-commit | in the pre-push hook, resolve the seeded areas; a changed file matching no area, and a seeded area with no `validation.profile`, both compute as `deep` (the same fail-closed default the catalog defines — see [§ Agent gate depth](reference/catalog/README.md#agent-gate-depth-validation)), so an empty or unmatched-only resolution is `deep`, never vacuously `shallow`; separately, walk the `impliedBy` closure of the seeded areas (not the seeds alone) and fail closed to a CI-identical sandbox if *any* reached area has `needsSandbox: true` — a dependency's sandbox requirement protects an affected dependent even when the dependent itself wasn't directly touched; skip the cross-worktree mutex ([M12](../M12-parallel-agent-ergonomics/)'s [`with-resource-lock.ts`](../M12-parallel-agent-ergonomics/reference/resource-lock/with-resource-lock.ts)) only when *both* computations clear: the deepest profile is all-`shallow` **and** the closure has no `needsSandbox: true` area — profile depth alone is seed-only and can't see a `needsSandbox` dependent reached only through closure |
| CI | re-run the deepest profile's full gate set regardless of what the local hook skipped — CI stays the authority ([M1](../M1-gates-enforcement-ladder/)) |

## Regex-mirror guard (optional optimization)

Only relevant if you keep a fast hand-written CI regex for "did code change?".
The runnable regex→catalog check ([`reference/regex-mirror/`](reference/regex-mirror/))
needs only Bun and runs in any CI. The catalog→regex direction needs the
resolver's area list — wire it into the same job that runs your catalog checker.

## Anchor corroboration recipe

Only relevant alongside the regex-mirror guard's `area-class-resolved`
check (see [`reference/regex-mirror/README.md`](reference/regex-mirror/README.md#matching-an-area-is-not-the-same-as-being-code-bearing)):
for each anchor area, prove its `workspace` has a source-controlled
deployment/release *reference* — a deployment manifest *or* a package-publish
step, external to `catalog.yaml` — not merely a textual mention of the path.
An anchor with an empty `workspace` (the schema permits this for a
[path-only area](reference/catalog/README.md)) has nothing there to start
from — use the area's own `paths` glob(s) as the starting evidence in the
recipes below instead; the artifact/reference column is otherwise unchanged.
A code-bearing area that never ships (a repo-owned test harness, linter, or
build tool) instead needs an **active heavy-gate/build CI job reference**
(the last table row) — same externality requirement, different target, and
the same path-only substitution when it has no `workspace`.
**These recipes certify that the reference exists and was reviewed, not
that it is currently live** — see the reference doc's "This is a baseline,
not a formal liveness proof" note for what's out of scope and how to
strengthen the evidence when your ecosystem's tooling supports it (a
rendered/applied inventory, an evaluated plan/state, real trigger analysis).

| Ecosystem | Workspace → artifact | Artifact → deployment/release reference | Known gap in this baseline |
|-----------|----------------------|------------------------------------------|------------------------------|
| Docker / Kubernetes | read the image name from the workspace's `Dockerfile` build args or a `package.json`/`build.yaml` image field | grep *workload* resources only (`Deployment`, `StatefulSet`, `DaemonSet` — resources that own a pod template; not `Service`, which has no image) for that image name in an `image:` field, under an enabled (non-`disabled/`, non-`.bak`, non-commented) path | presence in the repo isn't proof the manifest is applied to a live cluster — strengthen with a rendered/applied inventory (e.g. `kubectl diff` against a GitOps source of truth) if you need that guarantee |
| Terraform | same image/artifact identifier, or the resource name declared in the workspace's own IaC snippet if it owns one | the identifier appears in a Terraform resource block that is not inside a `count = 0` / commented-out block | `count`/`for_each` driven by a variable, a conditional module, or config that's never planned/applied all evade a source-text check — strengthen with an evaluated `terraform plan`/state JSON if you need that guarantee |
| GitHub Actions / CD pipeline | the workspace path itself, if the pipeline builds directly from source (no separate artifact step) | the path appears in a step of a job that (a) belongs to a workflow with at least one `on:` trigger declared — `workflow_dispatch` counts as real (a manual-gated production promotion is a legitimate release reference, see [M10](../M10-environments-deploy/)'s manual-promotion model), only a workflow with **no** trigger at all is orphaned — and (b) has no job- or step-level condition that is a literal, always-false expression (`if: false`) | full trigger reachability (event/path filters, job dependency graphs, non-literal always-false expressions) is a static-analysis problem this baseline doesn't attempt — strengthen with a workflow-reachability linter if you need that guarantee |
| Package registry (library-shaped repos) | the workspace's package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.) name/version | the package name appears in a publish step of an enabled CI job (`npm publish`, `twine upload`, `cargo publish`, ...) — same enabled/non-dead conditions as the CD pipeline row | this baseline doesn't verify the publish step has ever actually succeeded; strengthen with registry-API confirmation (does the version exist on the registry) if you need that guarantee |
| Internal tooling (non-shipping, code-bearing — test harness, linter, build tool) | the workspace path itself | the path appears as the working directory, target, or invoked command of a step in an enabled job that runs that area's heavy build/test gate — same enabled/non-dead conditions as the CD pipeline row, but the target is the gate running, not a deploy or publish | this doesn't prove the job's result actually *gates* anything (blocks merge on failure) — strengthen with a branch-protection/required-check lookup if you need that guarantee |

The negative fixtures every implementation needs, regardless of ecosystem: a
commented-out reference, a `disabled: true` / `if: false` job, and an
orphaned workflow file with no real trigger — all of these must **fail**
corroboration even though the workspace path or artifact name textually
appears in the file.
