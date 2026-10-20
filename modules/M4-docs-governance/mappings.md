# M4 mappings — per-ecosystem implementations

The module [invariant](README.md) — validated frontmatter, generated
navigation, scar-free approved docs, a written authority hierarchy — is
tool-independent. This file maps its checks onto concrete
[CI](../../GLOSSARY.md) providers and [git hook](../../GLOSSARY.md) managers.
Replace `<placeholders>` with your values.

## The gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| Frontmatter valid | pre-commit over staged `docs/**/*.md` | blocking; closes the `--no-verify` hole |
| `last_updated` advanced | pre-commit: `stale-last-updated.ts --staged` | blocking: `DIFF_RANGE=<base>...HEAD` with full history |
| Index and orphan report fresh | pre-commit: regenerate + auto-stage `INDEX.md` and `.orphans.md` | blocking: `generate-index.ts --check` |
| No scars in approved docs | (optional) pre-commit | advisory scan + blocking self-test |
| A deferral names an item | pre-commit: `check-deferrals.ts --staged` | blocking: `--range=<base>...HEAD` with full history |
| The item a deferral names is still open | none: needs the tracker credential | scheduled on the default branch, never on a pull request |

The pattern throughout: hooks are the fast, bypassable convenience; CI
re-runs the same checks and is the authority (see M1).

The recipes name the scripts as `<m4>/…`, where `<m4>` is
`modules/M4-docs-governance/reference` inside a pinned Jig checkout, or inside
a vendored copy that keeps Jig's layout (the `modules/` and `lib/` folders side
by side; see below for why the frontmatter checker needs `lib/`).

### GitHub Actions

```yaml
# .github/workflows/docs-governance.yml. No path filter on the trigger: a
# required check must report on every pull request (M1), so the job selects
# its own work.
on:
  pull_request:
jobs:
  docs:
    runs-on: ubuntu-latest
    env:
      BASE: origin/${{ github.base_ref }}  # the target branch, passed as data
      M4: <m4>
      VENDORED: ""                     # a vendored copy: its <m4> and lib/ paths, space-separated
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { fetch-depth: 0 }        # the merge base, new-doc detection and the scar lint need history
      - name: Select the work
        id: scope
        run: git diff --quiet "$BASE"...HEAD -- docs/ $VENDORED || echo "docs=true" >> "$GITHUB_OUTPUT"
      - name: Frontmatter valid (blocking)
        if: steps.scope.outputs.docs
        run: |
          # -z: file names verbatim; a file, not a pipe, so a failing git diff stops the step
          list=$(mktemp)
          git diff -z --name-only --diff-filter=A "$BASE"...HEAD -- 'docs/*.md' > "$list"
          export NEW_DOCS="$(tr '\0' '\n' < "$list")"
          if git diff --quiet "$BASE"...HEAD -- docs/.frontmatter-schema.yaml $VENDORED; then
            git diff -z --name-only --diff-filter=ACMR "$BASE"...HEAD -- 'docs/*.md' > "$list"
            mapfile -d '' files < "$list"
            [ ${#files[@]} -eq 0 ] || bun "$M4/frontmatter-check/frontmatter-check.ts" "${files[@]}"
          else
            bun "$M4/frontmatter-check/frontmatter-check.ts"  # the schema or checker changed: check every document
          fi
      - name: last_updated advanced with the body (blocking)
        if: steps.scope.outputs.docs
        run: DIFF_RANGE="$BASE...HEAD" bun "$M4/stale-last-updated/stale-last-updated.ts" --ci
      - name: Index and orphan report fresh (blocking)
        if: steps.scope.outputs.docs
        run: bun "$M4/index/generate-index.ts" --check
      - name: Scar-lint self-test (blocking)
        if: steps.scope.outputs.docs
        run: bun test "$M4/scar-lint/check-descarring-scars.test.ts"
      - name: Scar-lint scan (advisory)
        if: steps.scope.outputs.docs
        run: |
          list=$(mktemp)
          git diff -z --name-only --diff-filter=ACMR "$BASE"...HEAD -- 'docs/*.md' > "$list"
          mapfile -d '' files < "$list"
          [ ${#files[@]} -eq 0 ] || bun "$M4/scar-lint/check-descarring-scars.ts" "${files[@]}"
        continue-on-error: true          # promote to blocking by deleting this line
```

The schema is listed with the documents because a change to it changes what
every document must satisfy: a new path rule or a narrowed enum is checked
against the whole tree, not only the documents the pull request touches. A
vendored checker counts the same way, so when you vendor it, set `VENDORED` to
its `<m4>` and `lib/` paths: that one value feeds both the step that selects
the work and the comparison that decides on the whole tree. On GitLab, add
those paths to the job's `changes:` list as well as to `VENDORED`. Renamed
documents (`R`) are checked at their new path, since a move into another
subtree can break that subtree's path rules.

File names come from `git diff -z`, which prints them verbatim, each ended by
a zero byte; without it git quotes a name holding a double quote, a backslash,
a control character such as a newline, or (under the default
`core.quotePath`) a non-ASCII character, and the quoted form names no file.
The list goes through a file rather than a pipe or process substitution, so
a failing `git diff` stops the step instead of reading as an empty list. The
pathspec is `'docs/*.md'`: in a git pathspec `*` crosses `/`, so it matches
every depth, while `'docs/**/*.md'` misses the documents directly under
`docs/`. `NEW_DOCS` takes one path per line, and the checker fails on an entry
that names no file it checked. `mapfile -d ''` needs bash 4.4 or later.

### GitLab CI

```yaml
docs-governance:
  # Merge-request pipelines only: CI_MERGE_REQUEST_DIFF_BASE_SHA is empty in
  # any other pipeline, and the stale gate needs it for its range.
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: ['docs/**/*']    # documents and the schema beside them; a vendored checker's paths too
  variables: { GIT_DEPTH: 0, M4: <m4>, VENDORED: "" }   # full history: the merge base must be present
  image: <an image with bun and bash>
  script:
    - |
      BASE="$CI_MERGE_REQUEST_DIFF_BASE_SHA"
      list=$(mktemp)
      git diff -z --name-only --diff-filter=A "$BASE"...HEAD -- 'docs/*.md' > "$list"
      export NEW_DOCS="$(tr '\0' '\n' < "$list")"
      if git diff --quiet "$BASE"...HEAD -- docs/.frontmatter-schema.yaml $VENDORED; then
        git diff -z --name-only --diff-filter=ACMR "$BASE"...HEAD -- 'docs/*.md' > "$list"
        mapfile -d '' files < "$list"
        [ ${#files[@]} -eq 0 ] || bun "$M4/frontmatter-check/frontmatter-check.ts" "${files[@]}"
      else
        bun "$M4/frontmatter-check/frontmatter-check.ts"
      fi
    - DIFF_RANGE="$CI_MERGE_REQUEST_DIFF_BASE_SHA...HEAD" bun "$M4/stale-last-updated/stale-last-updated.ts" --ci
    - bun "$M4/index/generate-index.ts" --check
    - bun test "$M4/scar-lint/check-descarring-scars.test.ts"
  # advisory scar scan as a separate allow_failure job:
docs-scars:
  allow_failure: true
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes: ['docs/**/*.md']
  variables: { GIT_DEPTH: 0, M4: <m4> }
  image: <an image with bun and bash>
  script:
    - |
      list=$(mktemp)
      git diff -z --name-only --diff-filter=ACMR "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD -- 'docs/*.md' > "$list"
      mapfile -d '' files < "$list"
      [ ${#files[@]} -eq 0 ] || bun "$M4/scar-lint/check-descarring-scars.ts" "${files[@]}"
```

Any CI that can run Bun runs every gate. The only provider
specifics are the base-diff expression (for new-doc detection, the stale gate's
range and diff-scoped scanning) and the advisory mechanism
(`continue-on-error` / `allow_failure`).

The stale gate needs two things from CI. A full history (`fetch-depth: 0`, or
GitLab's `GIT_DEPTH: 0`), because a triple-dot range reads the old side at the
merge base, and a shallow clone may not hold it; the gate exits 2 when the
range does not resolve rather than passing. And the range itself: with `--ci`
and no `DIFF_RANGE` it prints `SKIP — …` and does not check, so a job that
misses the variable says so in its log. A range that is set but malformed (an
unset base variable turns `$BASE...HEAD` into `...HEAD`) is an error in every
mode, so run the job only where its base exists: on `pull_request` events, or
GitLab's merge-request pipelines as above.

The M4 scripts need only `<m4>` (`docs.ts` and `stamp/` are shared inside it),
except the frontmatter checker: it parses the schema with js-yaml from Jig's
`lib/vendor/`, at `../../../../lib/vendor/js-yaml.mjs` from
`<m4>/frontmatter-check/`. That is why `<m4>` sits in a checkout or a copy
with Jig's layout, `modules/M4-docs-governance/reference/` beside `lib/`, and
not on its own at the repository root. Without `lib/` the checker exits 2
rather than reading the schema another way.

## Hook managers (index auto-stage + fast frontmatter feedback)

| Manager | Wiring |
|---------|--------|
| [lefthook](https://github.com/evilmartians/lefthook) | pre-commit `docs-index-fresh`: `glob: "docs/**/*.md"`, `run: bun <m4>/index/generate-index.ts && git add docs/INDEX.md docs/.orphans.md`, `stage_fixed: true`; pre-commit `frontmatter`: `glob: "docs/**/*.md"`, `run: bun <m4>/frontmatter-check/frontmatter-check.ts {staged_files}`; pre-commit `docs-last-updated`: `glob: "docs/**/*.md"`, `run: bun <m4>/stale-last-updated/stale-last-updated.ts --staged {staged_files}` |
| [husky](https://typicode.github.io/husky/) | in `.husky/pre-commit`: guard on `git diff --cached --name-only \| grep -q '^docs/.*\.md$'`, then run the generator + `git add docs/INDEX.md docs/.orphans.md`, then the frontmatter check, then `stale-last-updated.ts --staged` |
| [pre-commit framework](https://pre-commit.com) | `repo: local` hooks with `files: '^docs/.*\.md$'`: one runs the frontmatter check, one `stale-last-updated.ts --staged`, one the index generator (a modified `INDEX.md` or `.orphans.md` fails the commit; `git add` + retry) |

## Deferral references

The static half runs where the other diff-aware gates run. In the GitHub
Actions job above, add a step after the `last_updated` one; it needs the same
full history and the same `$BASE`:

```yaml
      - name: A deferral names an item (blocking)
        if: steps.scope.outputs.docs
        run: bun "$M4/deferral-references/check-deferrals.ts" --ci --range="$BASE...HEAD"
```

On GitLab, in the `docs-governance` job's script:
`bun "$M4/deferral-references/check-deferrals.ts" --ci --range="$CI_MERGE_REQUEST_DIFF_BASE_SHA...HEAD"`.
With `--ci` and no range the gate prints `SKIP` and passes, so a job that lost
its base says so; a malformed range is an error. Add the configuration file
(`.config/deferral-references.yaml`) to the job's `changes:` list and to the
set that selects the work, since a new `items` pattern changes what every
document must satisfy.

| Hook manager | Wiring |
|--------------|--------|
| lefthook | pre-commit `deferrals`: `glob: "*.md"`, `run: bun <m4>/deferral-references/check-deferrals.ts --staged` |
| husky | in `.husky/pre-commit`, after the `last_updated` check: `bun <m4>/deferral-references/check-deferrals.ts --staged` |
| pre-commit framework | `repo: local` hook, `files: '\.md$'`, `pass_filenames: false`, `entry: bun <m4>/deferral-references/check-deferrals.ts --staged` |

The gate takes no file names: it judges the staged change, so `pass_filenames`
and `{staged_files}` are unused.

The live half has three steps and one credential (the
[workflow template](templates/deferral-liveness.yml) is the GitHub Actions
form). The scheduled trigger and the rule that a manual run is allowed only on
the default branch are the provider specifics:

| CI | Scheduled run | Credential |
|----|---------------|------------|
| GitHub Actions | `on: schedule`; `workflow_dispatch` with the job `if:` limited to the default branch | A repository secret, in the `env:` of the one step that calls the tracker; not a job-level or workflow-level `env:` |
| GitLab CI | A pipeline schedule on the default branch; `rules: - if: $CI_PIPELINE_SOURCE == "schedule"` | A CI/CD variable marked masked and protected, so only protected branches' pipelines receive it |
| Other | A scheduler that runs the default branch's pipeline | A secret that merge-request or pull-request pipelines cannot read |

The provider is a command that reads item keys on standard input, one per line,
and prints a JSON object from each key to `open`, `closed` or `not_found`. It
must exit non-zero when it could not ask, and when it was asked about an item
it could not classify. Per tracker:

| Tracker | Provider |
|---------|----------|
| Linear, through Jig's tracker interface (the adapter `issue_tracker.adapter` names) | `bun <jig>/plugin/skills/do-item/scripts/tracker.ts issue-states` with `issue_tracker` in `.config/jig.yaml` and the adapter's credential in the environment (`LINEAR_API_KEY` for Linear). It reads the state category of each item through the tracker interface: `completed`, `canceled` and `duplicate` are `closed`, a missing item is `not_found`, and an issue the tracker reports without a category fails the run |
| GitHub Issues | One `gh issue view <number> --repo <owner/name> --json state` per key, mapping `OPEN` to `open` and `CLOSED` to `closed`; an `items` pattern whose capture group is the issue number; `gh` exits non-zero for a missing issue, which the wrapper maps to `not_found` only on that error, never on a network failure |
| Jira | `GET /rest/api/3/issue/<key>?fields=status`, mapping `status.statusCategory.key` of `done` to `closed` and any other to `open`, a 404 to `not_found`; every other status code fails the provider |
| A plan file in the repository | A script that reads the item's status from the file; no credential, so it can run in the pull-request check beside the static half |

A provider that maps a failed request to `not_found` turns an outage into a
report that every item is gone, or the reverse; keep "does not exist" and
"could not ask" apart.

## Schema format

The schema template is YAML because the frontmatter is YAML, but the checker
only relies on the regular `values: [...]` / list shape — any format your repo
prefers works as long as the reader is adjusted. Keeping the schema **machine
read at runtime** (rather than duplicating the enums inside the checker) is the
point: the schema is the single source of truth for the doc vocabulary.
