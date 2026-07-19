# M4 mappings — per-ecosystem implementations

The module [invariant](README.md) — validated frontmatter, generated
navigation, scar-free approved docs, a written authority hierarchy — is
tool-independent. This file maps its checks onto concrete
[CI](../../GLOSSARY.md) providers and [git hook](../../GLOSSARY.md) managers.
Replace `<placeholders>` with your values.

## The three gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| Frontmatter valid | pre-commit over staged `docs/**/*.md` | blocking; closes the `--no-verify` hole |
| Index fresh | pre-commit: regenerate + auto-stage `INDEX.md` | blocking: `generate-index.sh --check` |
| No scars in approved docs | (optional) pre-commit | advisory scan + blocking self-test |

The pattern throughout: hooks are the fast, bypassable convenience; CI
re-runs the same checks and is the authority (see M1).

### GitHub Actions

```yaml
# .github/workflows/docs-governance.yml — path-filtered to docs changes.
on:
  pull_request:
    paths: ['docs/**/*.md']
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }        # scar lint / new-doc detection need the diff
      - name: New docs (require description)
        id: new
        run: echo "files=$(git diff --name-only --diff-filter=A origin/${{ github.base_ref }}...HEAD -- 'docs/**/*.md' | tr '\n' ' ')" >> "$GITHUB_OUTPUT"
      - name: Frontmatter valid (blocking)
        run: NEW_DOCS="${{ steps.new.outputs.files }}" reference/frontmatter-check/frontmatter-check.sh $(git diff --name-only --diff-filter=ACM origin/${{ github.base_ref }}...HEAD -- 'docs/**/*.md')
      - name: Index fresh (blocking)
        run: reference/index/generate-index.sh --check
      - name: Scar-lint self-test (blocking)
        run: reference/scar-lint/test-descarring-scars.sh
      - name: Scar-lint scan (advisory)
        run: reference/scar-lint/check-descarring-scars.sh $(git diff --name-only --diff-filter=ACM origin/${{ github.base_ref }}...HEAD -- 'docs/**/*.md')
        continue-on-error: true          # promote to blocking by deleting this line
```

### GitLab CI

```yaml
docs-governance:
  rules:
    - changes: ['docs/**/*.md']
  script:
    - NEW=$(git diff --name-only --diff-filter=A "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD -- 'docs/**/*.md')
    - NEW_DOCS="$NEW" reference/frontmatter-check/frontmatter-check.sh $(git diff --name-only --diff-filter=ACM "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD -- 'docs/**/*.md')
    - reference/index/generate-index.sh --check
    - reference/scar-lint/test-descarring-scars.sh
  # advisory scar scan as a separate allow_failure job:
docs-scars:
  allow_failure: true
  rules: [{ changes: ['docs/**/*.md'] }]
  script: reference/scar-lint/check-descarring-scars.sh $(git diff --name-only --diff-filter=ACM "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD -- 'docs/**/*.md')
```

Any CI that runs a shell script runs all three gates. The only provider
specifics are the base-diff expression (for new-doc detection and diff-scoped
scanning) and the advisory mechanism (`continue-on-error` / `allow_failure`).

## Hook managers (index auto-stage + fast frontmatter feedback)

| Manager | Wiring |
|---------|--------|
| [lefthook](https://github.com/evilmartians/lefthook) | pre-commit `docs-index-fresh`: `glob: "docs/**/*.md"`, `run: reference/index/generate-index.sh && git add docs/INDEX.md`, `stage_fixed: true`; pre-commit `frontmatter`: `glob: "docs/**/*.md"`, `run: reference/frontmatter-check/frontmatter-check.sh {staged_files}` |
| [husky](https://typicode.github.io/husky/) | in `.husky/pre-commit`: guard on `git diff --cached --name-only \| grep -q '^docs/.*\.md$'`, then run the generator + `git add docs/INDEX.md`, then the frontmatter check |
| [pre-commit framework](https://pre-commit.com) | two `repo: local` hooks with `files: '^docs/.*\.md$'`: one runs the frontmatter check, one runs the index generator (the modified `INDEX.md` fails the commit; `git add` + retry) |

## Schema format

The schema template is YAML because the frontmatter is YAML, but the checker
only relies on the regular `values: [...]` / list shape — any format your repo
prefers works as long as the reader is adjusted. Keeping the schema **machine
read at runtime** (rather than duplicating the enums inside the checker) is the
point: the schema is the single source of truth for the doc vocabulary.
