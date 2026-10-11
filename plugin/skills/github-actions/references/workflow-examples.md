# Workflow examples

Examples for the [github-actions review checklist](../SKILL.md). They use
GitHub Actions expressions (`${{ … }}`), so they live here rather than in
`SKILL.md`. Action references are pinned to commit SHAs, as checklist item 1.0
requires.

## Secret check

Check that a secret is set before using it. Pass it in through `env:` rather
than writing the expression into the script, so its value never becomes part
of the script text.

```yaml
- name: Validate secrets
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: |
    if [ -z "$API_KEY" ]; then
      echo "Error: API_KEY secret not set"
      exit 1
    fi
```

## Conditional jobs

When a workflow detects which parts changed, every downstream job carries an
`if:` condition on that result:

```yaml
jobs:
  detect-changes:
    outputs:
      code-changed: ${{ steps.changes.outputs.code }}

  code-quality:
    needs: detect-changes
    if: needs.detect-changes.outputs.code-changed == 'true'
```

## Artifact naming

Name the artifact after the commit SHA and fail when nothing was found:

```yaml
- uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
  with:
    name: verified-api-${{ github.sha }}
    retention-days: 90
    if-no-files-found: error
```

## Caching

The package manager's dependency cache, and a task runner's remote cache
where the repository uses one. The package manager version stays in step with
the repository's own pin:

```yaml
env:
  NODE_VERSION: '24'
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}   # Turborepo remote cache, where used
  TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

steps:
  - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4
    with:
      version: 10.30.1                 # keep in step with package.json's packageManager

  - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
    with:
      node-version: ${{ env.NODE_VERSION }}
      cache: 'pnpm'
```
