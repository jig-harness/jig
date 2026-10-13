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

Each area's `tracker.labels` (and process-driving `tracker.flags`, see the
[flag-label](../../GLOSSARY.md) concept and [M9](../M9-tasks-memory/)) become
tracker labels applied to the PR/issue for the resolved areas.

| Tracker | Apply labels |
|---------|-------------|
| GitHub | `gh pr edit --add-label` in a CI step, or `actions/labeler` fed the generated area→label map |
| GitLab | scoped labels via the API in a job, or `/label` quick-actions in an MR note |
| Linear / Jira | the tracker's API/automation, mapping resolved area → label; a `flag` label (e.g. `has-migration`) can trigger a mandatory review gate |

## Deploy tiers & post-deploy actions

`deployTier` groups areas into deploy lanes; `postDeploy` actions are collected
for the affected areas into a checklist the promote step runs. This is a data
projection — the deploy system stays generic:

| System | Consume the projection |
|--------|------------------------|
| GitHub Actions deploy workflow | read the resolved `deployTier`/`postDeploy` JSON to pick the environment and the post-deploy step |
| Argo / Flux / other GitOps | map `deployTier` to a sync wave or a target cluster; post-deploy actions as post-sync hooks |
| Manual runbook | render the post-deploy checklist (Markdown projection) into the release notes / PR body |

## Regex-mirror guard (optional optimization)

Only relevant if you keep a fast hand-written CI regex for "did code change?".
The runnable regex→catalog check ([`reference/regex-mirror/`](reference/regex-mirror/))
needs only Bun and runs in any CI. The catalog→regex direction needs the
resolver's closure — wire it into the same job that runs your catalog checker.
