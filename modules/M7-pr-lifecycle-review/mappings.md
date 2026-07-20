# M7 mappings — per-ecosystem implementations

The module [invariant](README.md) — draft PRs, change-area-selected reviews,
layered comment-only-until-proven reviewers, a resolve-every-thread loop, a
human Ready + merge, fork-safe wiring — is tool-independent. This file maps its
mechanisms onto concrete forges, [review bots](../../GLOSSARY.md), agent
runtimes, [CI](../../GLOSSARY.md) providers, and [issue trackers](../../GLOSSARY.md).
Replace `<placeholders>` with your values.

## The two gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| PR-target safety lint | pre-commit over `.github/workflows/**` (optional) | blocking; the authority — the workflows are the thing checked |
| Unresolved-threads | n/a (needs the forge's thread state) | blocking merge gate, after the thread-state export step |

The change-area review *selection* is not a gate here — it rides on
[M3](../M3-change-area-catalog/)'s review-gate projection, which decides which
mandatory reviewers a PR needs.

Two things these examples get right and you must not drop:

- **Run the gate logic from the BASE, not the PR checkout.** A merge-blocking
  gate that runs scripts out of the PR's own checkout is not a gate — the PR can
  edit the script (or the workflow) to report success. Check the PR's tree out
  as *data* to be scanned, and run the gate scripts from a separately
  checked-out base tree the PR cannot alter (or a pinned reusable workflow).
- **Use paths that exist after checkout.** The scripts live under the module
  directory (`modules/M7-pr-lifecycle-review/reference/...` as shipped). Set one
  `M7` variable to wherever you vendored the module and build every path from
  it; a bare `reference/...` resolves from the repo root and will not be found.

### GitHub Actions

```yaml
# .github/workflows/pr-hygiene.yml — runs on pull_request (no secrets for forks)
on:
  pull_request: {}
jobs:
  hygiene:
    runs-on: ubuntu-latest
    env:
      M7: base/modules/M7-pr-lifecycle-review   # gate scripts, from the base tree
    steps:
      # The PR's tree — inspected as DATA only; its scripts never run the gate.
      - uses: actions/checkout@v4
        with: { path: pr }
      # The gate scripts, from the BASE commit the PR targets — the PR cannot
      # edit these, so it cannot make an unsafe workflow report success.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - name: Reviewer wiring is fork-safe (blocking)
        # scan the PR's workflow files as data; run the trusted, base-owned gate
        run: WORKFLOWS_DIR=pr/.github/workflows "$M7"/reference/pr-target-safety/check-pr-target-safety.sh
      - name: Gate self-tests (blocking)
        run: |
          "$M7"/reference/pr-target-safety/test-check-pr-target-safety.sh
          "$M7"/reference/comment-resolution/test-check-threads-resolved.sh
      - name: Export review-thread states
        # paginated query + inline jq converter (the whole adapter, nothing to
        # hunt for); resolvers prefix the closing comment with the outcome word.
        env: { GH_TOKEN: ${{ github.token }} }
        run: |
          gh api graphql --paginate \
            -F owner='${{ github.repository_owner }}' \
            -F repo='${{ github.event.repository.name }}' \
            -F pr='${{ github.event.pull_request.number }}' \
            -f query='
              query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
                repository(owner:$owner,name:$repo){
                  pullRequest(number:$pr){
                    reviewThreads(first:100,after:$endCursor){
                      pageInfo{ hasNextPage endCursor }
                      nodes{ id isResolved comments(last:1){ nodes{ body } } }
                    }}}}' \
            --jq '.data.repository.pullRequest.reviewThreads.nodes[]
                  | (.comments.nodes[-1].body // "" | gsub("\\s+";" ")) as $last
                  | if (.isResolved|not) then "\(.id) open" else "\(.id) \($last)" end' \
            > pr-threads.txt
      - name: Every thread resolved with a trail (blocking merge)
        run: THREADS=pr-threads.txt "$M7"/reference/comment-resolution/check-threads-resolved.sh
```

### GitLab CI

```yaml
pr_hygiene:
  variables:
    M7: modules/M7-pr-lifecycle-review     # point at where you vendored the module
  script:
    # On GitLab, run from a protected branch's copy of the scripts (or a
    # component) so a fork MR cannot alter the gate it must pass.
    - WORKFLOWS_DIR=.gitlab/ci "$M7"/reference/pr-target-safety/check-pr-target-safety.sh
    - "$M7"/reference/pr-target-safety/test-check-pr-target-safety.sh
    - "$M7"/reference/comment-resolution/test-check-threads-resolved.sh
    - |
      glab api "projects/:id/merge_requests/$CI_MERGE_REQUEST_IID/discussions" \
        --paginate \
        | jq -r '.[] | select(.resolvable) | .notes[-1] as $n
                 | if .resolved then "\(.id) \($n.body|gsub("\\s+";" "))"
                   else "\(.id) open" end' > mr-threads.txt
    - THREADS=mr-threads.txt "$M7"/reference/comment-resolution/check-threads-resolved.sh
```

## Forges — lifecycle primitives + thread-state export

| Forge | Draft PR | Human-only merge | Thread state → gate input |
|-------|----------|------------------|---------------------------|
| GitHub | native draft PRs | branch protection: required reviews + required checks, no self-merge of bot PRs | GraphQL `pullRequest.reviewThreads` (`isResolved`, last comment) → map to `addressed`/`rejected`/`deferred`/`open` |
| GitLab | `Draft:` title prefix | protected branch + "all threads resolved" + approval rules | `merge_requests/:iid/discussions` (`resolved`, `resolvable`) → same mapping |
| Gitea / Forgejo | native draft PRs | branch protection + required approvals | conversations API → same mapping |

The mapping from a forge's boolean (`isResolved`) + resolution comment to the
gate's `addressed | rejected | deferred | open` states is the inline `--jq` /
`jq` filter shown in the export steps above — the whole adapter, checked in with
the workflow, nothing to hunt for. Convention: resolvers prefix the closing
comment with the outcome keyword so the filter can read it; an unresolved thread
emits `open`.

## Review bots / harness (the tool registry)

Each reviewer is one entry in [`review-config.yaml`](templates/review-config.yaml)
with a `posture`. New reviewers enter **comment-only**; promotion to blocking is
[HITL](../../GLOSSARY.md) and gated on measured precision ([M8](../M8-learning-loop/)).

| Reviewer | Role | Typical posture |
|----------|------|-----------------|
| In-house [shadow reviewer](../../GLOSSARY.md) (this harness) | additive numbered lenses, grown by the learning loop | comment-only until its bar clears |
| CodeRabbit / Greptile / other commercial bot | static-analysis + AST depth | comment-only until it clears the same measured-precision bar |
| Agent-runtime reviewer (Claude Code / Codex / Cursor `/review`) | on-demand local tiered review before pushing | advisory / author-side |
| Humans | judgment + sign-off; selected per change-area | authoritative (a "request changes" blocks) |

## CI providers

Any provider works — the two gates are plain shell. The only provider-specific
piece is the thread-state export step (a forge API call), shown above for
GitHub Actions and GitLab CI.

## Issue trackers

| Tracker | Wiring |
|---------|--------|
| GitHub / GitLab issues | a `hitl` label revokes autonomous merge for the linked PR; a PR-template checkbox "threads resolved / follow-ups filed" |
| Linear / Jira | a `hitl` label (see [M0](../M0-instruction-architecture/) / [M9](../M9-tasks-memory/)) marks a deliverable whose merge stays human; deferred threads become linked follow-up issues, whose ids are the `deferred` gate's trail |

The human checkpoints (**mark Ready**, **merge**, **promote a reviewer to
blocking**) are enforced by forge settings + the [HITL registry](templates/HITL-REGISTRY.md),
not by a script — a bot must not hold those.
