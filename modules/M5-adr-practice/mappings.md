# M5 mappings — per-ecosystem implementations

The module [invariant](README.md) — numbered immutable records, a collision
gate, amendment-not-rewrite, decisions-become-checks — is tool-independent.
This file maps its mechanisms onto concrete [git hook](../../GLOSSARY.md)
managers, [CI](../../GLOSSARY.md) providers, and issue trackers. Replace
`<placeholders>` with your values.

## The gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| ADR numbering | pre-push: `check-adr-numbers.ts` | blocking; mirror of the hook so `--no-verify` can't ship a duplicate |
| ADR-rule checks | pre-commit over staged code | blocking (critical) / advisory (warnings) |
| Skeleton files | `commit-msg`: `check-skeleton-adr.ts <message-file>` | blocking; the authority, over the pull request's whole range, in a job of its own |

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
  skeleton:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: oven-sh/setup-bun@<full-commit-sha> # v2
        with: { bun-version: <bun-version> }
      - name: Skeleton files need recorded authority (blocking)
        run: |
          git clone -q https://github.com/docomply/jig "$RUNNER_TEMP/jig"
          git -C "$RUNNER_TEMP/jig" checkout -q --detach <jig-commit-sha>
          : > "$RUNNER_TEMP/bunfig.toml"
          bun --config="$RUNNER_TEMP/bunfig.toml" --no-env-file \
            "$RUNNER_TEMP/jig/modules/M5-adr-practice/reference/skeleton-gate/check-skeleton-adr.ts" \
            --base "${{ github.event.pull_request.base.sha }}" --head "${{ github.event.pull_request.head.sha }}"
```

The skeleton gate reads the pull request's commits; it never runs their code.
Each part of the `skeleton` job closes a way a change could make it pass
without touching the inventory or naming a record:

- **The gate's code** comes from a Jig checkout pinned to one commit, outside
  the checkout under review, so a change cannot replace the gate or a helper
  it imports. Run from that checkout, its imports (relative to its own file)
  resolve; a vendored copy keeps the same layout
  ([gate README](reference/skeleton-gate/README.md#design-notes)).
- **The runtime's inputs.** Bun reads `bunfig.toml` and `.env` files from
  the working directory, which is the checkout under review: a `preload`
  there runs before the gate, and an `.env` can set variables the gate's
  `git` calls obey. `--config` points Bun at an empty file instead, and
  `--no-env-file` turns the `.env` loading off.
- **No code from the change runs first.** The gate has a job of its own:
  in the `adr` job a changed rule script or test runs before any later step
  and could move a ref that step reads. The base is the event's commit
  (`pull_request.base.sha`), not a branch name resolved at run time.

The head is the pull request's own head commit, not the merge commit GitHub
builds for the run: the merge commit's message is not the author's, and its
tree is not the one the author wrote. `fetch-depth: 0` makes that commit and
the base's history available.

### GitLab CI

```yaml
adr:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - bun reference/numbering-gate/check-adr-numbers.ts
    - bun test reference/decisions-to-checks/adr-rules-check.test.ts
    - RULES=.adr-rules.yaml bun reference/decisions-to-checks/adr-rules-check.ts $(git diff --name-only "$CI_MERGE_REQUEST_DIFF_BASE_SHA"...HEAD)

skeleton:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  inherit: { default: false }
  image: <image-with-bun-and-git>@sha256:<digest>
  variables: { GIT_DEPTH: 0 }
  script:
    - jig="$(mktemp -d)/jig" && git clone -q https://github.com/docomply/jig "$jig"
    - git -C "$jig" checkout -q --detach <jig-commit-sha>
    - bunfig="$(mktemp)"
    - bun --config="$bunfig" --no-env-file "$jig/modules/M5-adr-practice/reference/skeleton-gate/check-skeleton-adr.ts" --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --head "${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-$CI_COMMIT_SHA}"
```

Both jobs read `CI_MERGE_REQUEST_DIFF_BASE_SHA`, which exists only in a
merge-request pipeline, and a job without `rules` is left out of those
pipelines, so each selects `merge_request_event` explicitly.
As on GitHub, the gate runs from a pinned Jig checkout in a job of its own
(`inherit: { default: false }` keeps a shared `before_script` from running
the change's code first). That also drops the default `image`, so the job
names its own: one that provides Bun and Git, pinned by digest. Bun's
configuration and `.env` loading are pinned too,
and the head is the merge request's own head commit: in a
merged-results pipeline `CI_COMMIT_SHA` is the synthetic merge commit, which
carries the target branch's commits too. The skeleton gate reads commit
messages, so its job needs full history (`GIT_DEPTH: 0`), as the GitHub job's
`fetch-depth: 0` does.

## Hook managers

| Manager | Wiring |
|---------|--------|
| [lefthook](https://github.com/evilmartians/lefthook) | pre-push `adr-numbers`: `run: bun reference/numbering-gate/check-adr-numbers.ts`; pre-commit `adr-rules`: `glob: "**/*.{ts,js,py,go}"`, `run: RULES=.adr-rules.yaml bun reference/decisions-to-checks/adr-rules-check.ts {staged_files}` |
| [husky](https://typicode.github.io/husky/) | `.husky/pre-push` runs the numbering gate; `.husky/pre-commit` runs the rules check over `git diff --cached --name-only --diff-filter=ACM` |
| [pre-commit framework](https://pre-commit.com) | a `repo: local` hook `id: adr-numbers` (`always_run: true`, `pass_filenames: false`) and one `id: adr-rules` with `files:` scoped to code |

The skeleton gate is a `commit-msg` hook, the one hook that sees the message
(see [M1's commit-msg marker](../M1-gates-enforcement-ladder/reference/commit-msg-marker/README.md)).
`<jig>` is a Jig checkout pinned to one commit, the same one CI pins
(`<jig>/modules/M5-adr-practice/reference/skeleton-gate/` holds the gate):

| Manager | Wiring |
|---------|--------|
| lefthook | `commit-msg` command `skeleton-adr`: `run: bun <jig>/modules/M5-adr-practice/reference/skeleton-gate/check-skeleton-adr.ts {1}` |
| husky | `.husky/commit-msg`: `bun <jig>/modules/M5-adr-practice/reference/skeleton-gate/check-skeleton-adr.ts "$1"` |
| pre-commit framework | a `repo: local` hook `id: skeleton-adr`, `stages: [commit-msg]`, `always_run: true`, `pass_filenames: true` (the framework passes the message file) |

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

## Ownership of the two authority paths

The skeleton gate checks that authority is *recorded*; who may record it is
the host's review rule. Give the inventory (`.config/skeleton.yaml`), the
decision-record directory, the CI definition that runs the gate (on
GitHub the `pull_request` workflow is read from the change itself), and the
ownership file itself (`CODEOWNERS`, or wherever the host keeps the rule) to
the people who own the architecture. Leave the ownership file out and a change
that touches none of the other paths can drop their entries, so the next change
edits the inventory or approves its own record with no owner review:

| Host | Rule |
|------|------|
| GitHub | a `CODEOWNERS` entry for these paths, with "Require review from Code Owners" on the protected branch |
| GitLab | a `CODEOWNERS` section with approval required, or an approval rule scoped to these paths |
| Bitbucket / Gerrit | a default reviewer group or a path-scoped approval rule for these paths |

Writing a *new* ADR when a decision changes (rather than editing the old one)
is the amendment/supersession discipline — cultural, backed by the
de-scarring lint (M4) that keeps the record clean, not by a bot.
