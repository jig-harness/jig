# M5 mappings — per-ecosystem implementations

The module [invariant](README.md) — numbered immutable records, a collision
gate, amendment-not-rewrite, decisions-become-checks — is tool-independent.
This file maps its mechanisms onto concrete [git hook](../../GLOSSARY.md)
managers, [CI](../../GLOSSARY.md) providers, and issue trackers. Replace
`<placeholders>` with your values.

## The two gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| ADR numbering | pre-push: `check-adr-numbers.ts` | blocking; mirror of the hook so `--no-verify` can't ship a duplicate |
| ADR-rule checks | pre-commit over staged code | blocking (critical) / advisory (warnings) |

ADR *frontmatter* validity is not a separate gate here — it rides on
[M4](../M4-docs-governance/)'s frontmatter checker, which enforces the
ADR-specific fields (`decision_date`, `supersedes`, `superseded_by`).

### GitHub Actions

```yaml
# .github/workflows/adr.yml
on: { pull_request: {} }
jobs:
  adr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { fetch-depth: 0 }
      - name: ADR numbers unique (blocking)
        run: bun reference/numbering-gate/check-adr-numbers.ts
      - name: ADR-rule self-test (blocking)
        run: bun test reference/decisions-to-checks/adr-rules-check.test.ts
      - name: ADR rules on changed code (blocking on critical)
        run: RULES=.adr-rules.yaml bun reference/decisions-to-checks/adr-rules-check.ts $(git diff --name-only origin/${{ github.base_ref }}...HEAD)
```

### GitLab CI

```yaml
adr:
  script:
    - bun reference/numbering-gate/check-adr-numbers.ts
    - bun test reference/decisions-to-checks/adr-rules-check.test.ts
    - RULES=.adr-rules.yaml bun reference/decisions-to-checks/adr-rules-check.ts $(git diff --name-only "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD)
```

## Hook managers

| Manager | Wiring |
|---------|--------|
| [lefthook](https://github.com/evilmartians/lefthook) | pre-push `adr-numbers`: `run: bun reference/numbering-gate/check-adr-numbers.ts`; pre-commit `adr-rules`: `glob: "**/*.{ts,js,py,go}"`, `run: RULES=.adr-rules.yaml bun reference/decisions-to-checks/adr-rules-check.ts {staged_files}` |
| [husky](https://typicode.github.io/husky/) | `.husky/pre-push` runs the numbering gate; `.husky/pre-commit` runs the rules check over `git diff --cached --name-only --diff-filter=ACM` |
| [pre-commit framework](https://pre-commit.com) | a `repo: local` hook `id: adr-numbers` (`always_run: true`, `pass_filenames: false`) and one `id: adr-rules` with `files:` scoped to code |

The numbering gate takes no file list (it scans the ADR dir), so `always_run`
it; the rules check takes the changed code files.

## Issue trackers (amendment / supersession bookkeeping)

Supersession is a two-file edit (new ADR `supersedes:`, old ADR
`superseded_by:` + `status: deprecated`). Trackers help *notice* when it's
needed but don't enforce it:

| Tracker | Support |
|---------|---------|
| GitHub / GitLab | a PR template checkbox "if this supersedes an ADR, both files updated"; a `decision` label routing ADR PRs to the right reviewers |
| Linear / Jira | an ADR issue type; a `hitl` label (see [M0](../M0-instruction-architecture/) / [M9](../M9-tasks-memory/)) marking that the deliverable is a decision, so the autonomous run stops for human sign-off |

Writing a *new* ADR when a decision changes (rather than editing the old one)
is the amendment/supersession discipline — cultural, backed by the
de-scarring lint (M4) that keeps the record clean, not by a bot.
