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

## Concurrency keys

Pull-request runs cancel the older head; a manual dispatch is a group of its
own; serialized post-merge verification keeps a fixed group and checks the
range from the verified pointer:

```yaml
# Pull-request gates: a new push cancels the runs of the older head
concurrency:
  group: pr-gates-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

```yaml
# A scheduled suite that can also be dispatched: the event name keeps a
# manual run out of the scheduled run's group, and a dispatch is keyed by its
# run id rather than by its inputs (group names compare case-insensitively)
concurrency:
  group: nightly-${{ github.event_name }}-${{ github.event_name == 'workflow_dispatch' && github.run_id || github.ref }}
  cancel-in-progress: true
```

```yaml
# Post-merge verification: one run at a time on the integration branch, never
# cancelled; the run checks every commit since the verified pointer, so the
# survivor covers a dropped intermediate push. A dispatch from any other ref
# cannot cover that range, so it gets a slot of its own.
concurrency:
  group: verify-${{ github.ref == 'refs/heads/main' && 'main' || github.run_id }}
  cancel-in-progress: false
```

## Expression through env

An expression inside `run:` is substituted into the script before the shell
reads it, so a value an outsider sets runs as code. Pass it through `env:`:

```yaml
# BAD: the title is pasted into the script text
- run: echo "Reviewing ${{ github.event.pull_request.title }}"

# GOOD: the title reaches the shell as a variable's value
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "Reviewing $PR_TITLE"
```
