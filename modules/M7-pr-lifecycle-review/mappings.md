# M7 mappings — per-ecosystem implementations

The module [invariant](README.md) — draft PRs, change-area-selected reviews,
layered comment-only-until-proven reviewers, a resolve-every-thread loop, a
Ready by a human or an adopted review driver, a human merge, reviewer code and policy independent of the reviewed
change, and fork-safe wiring — is tool-independent. This file maps its
mechanisms onto concrete forges, [review bots](../../GLOSSARY.md), agent
runtimes, [CI](../../GLOSSARY.md) providers, and
[issue trackers](../../GLOSSARY.md). Replace `<placeholders>` with your values.

## The gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| PR-target safety lint | pre-commit over `.github/workflows/**` (optional) | blocking; the authority — the workflows are the thing checked |
| Unresolved-threads | n/a (needs the forge's thread state) | blocking merge gate, after the thread-state export step |
| Round convergence | n/a (needs the forge's PR + reviewer state) | not a merge gate — a **loop step** whose exit code is control flow (see § Round convergence below) |

The change-area review *selection* is not a gate here — it rides on
[M3](../M3-change-area-catalog/)'s review-gate projection, which decides which
mandatory reviewers a PR needs.

Three things these examples get right and you must not drop:

- **Run the gate logic from the BASE, not the PR checkout.** A merge-blocking
  gate that runs scripts out of the PR's own checkout is not a gate — the PR can
  edit the script (or the workflow) to report success. Check the PR's tree out
  as *data* to be scanned, and run the gate scripts from a separately
  checked-out base tree the PR cannot alter (or a pinned reusable workflow).
- **The PR cannot define its own reviewer.** Load a secret-bearing or
  merge-relevant reviewer's runtime, prompts, and active policy from a pinned
  external version, separately hosted service, or the target base branch. If a
  PR changes reviewer code or policy, exercise that proposal only in a separate
  unprivileged, comment-only shadow job; the authoritative review keeps using
  the previously trusted version.
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
      - uses: actions/checkout@<full-commit-sha> # v4
        with: { path: pr }
      # The gate scripts, from the BASE commit the PR targets — the PR cannot
      # edit these, so it cannot make an unsafe workflow report success.
      - uses: actions/checkout@<full-commit-sha> # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - name: Reviewer wiring is fork-safe (blocking)
        # scan the PR's workflow files as data; run the trusted, base-owned gate
        run: WORKFLOWS_DIR=pr/.github/workflows bun "$M7"/reference/pr-target-safety/check-pr-target-safety.ts
      - name: Gate self-tests (blocking)
        run: |
          bun test "$M7"/reference/pr-target-safety/check-pr-target-safety.test.ts
          bun test "$M7"/reference/comment-resolution/check-threads-resolved.test.ts
          bun test "$M7"/reference/comment-resolution/normalize-thread-states.test.ts
          bun test "$M7"/reference/review-convergence/check-round-converged.test.ts
      - name: Export review-thread rows
        # The API emits ROWS — id, resolved, reply body — and nothing more.
        # Decoding the declared verdict is the next step's job, not this one's.
        #
        # Several rows per thread, NEWEST REPLY FIRST. Do not send only the last
        # comment: a reviewer answering "confirmed" after the author's
        # `**accepted** — fixed in abc1234` would bury the verdict, and the thread
        # would export as `unclassified` and block a correct resolution. The
        # exporter takes the freshest reply that actually declares one.
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
                      nodes{ id isResolved comments(last:20){ nodes{ body } } }
                    }}}}' \
            --jq '.data.repository.pullRequest.reviewThreads.nodes[]
                  | .id as $id
                  | (.isResolved | tostring) as $res
                  | [ .comments.nodes[].body // "" ] | reverse
                  | .[] | [ $id, $res, (gsub("\\s+";" ")) ] | @tsv' \
            > pr-thread-rows.tsv
      - name: Decode declared verdicts into gate states
        # The one place the reply encoding is decoded — checked in, self-tested
        # against the gate. Piping reply bodies straight into the gate instead
        # makes every declared verdict an unknown state (see § below).
        run: |
          VERDICT_ENCODING=token \
            bun "$M7"/reference/comment-resolution/normalize-thread-states.ts \
            pr-thread-rows.tsv > pr-threads.txt
      - name: Every thread resolved with a trail (blocking merge)
        run: THREADS=pr-threads.txt bun "$M7"/reference/comment-resolution/check-threads-resolved.ts
```

### GitLab CI

```yaml
pr_hygiene:
  variables:
    M7: modules/M7-pr-lifecycle-review     # point at where you vendored the module
  script:
    # On GitLab, run from a protected branch's copy of the scripts (or a
    # component) so a fork MR cannot alter the gate it must pass.
    - WORKFLOWS_DIR=.gitlab/ci bun "$M7"/reference/pr-target-safety/check-pr-target-safety.ts
    - bun test "$M7"/reference/pr-target-safety/check-pr-target-safety.test.ts
    - bun test "$M7"/reference/comment-resolution/check-threads-resolved.test.ts
    - bun test "$M7"/reference/comment-resolution/normalize-thread-states.test.ts
    - bun test "$M7"/reference/review-convergence/check-round-converged.test.ts
    # Same two steps as GitHub: rows out of the API, verdicts decoded by the
    # checked-in exporter. Only the API call differs — and, as there, every note
    # is emitted newest-first rather than just `.notes[-1]`.
    - |
      glab api "projects/:id/merge_requests/$CI_MERGE_REQUEST_IID/discussions" \
        --paginate \
        | jq -r '.[] | select(.resolvable)
                 | (.id|tostring) as $id | (.resolved|tostring) as $res
                 | [ .notes[].body // "" ] | reverse
                 | .[] | [ $id, $res, (gsub("\\s+";" ")) ] | @tsv' > mr-thread-rows.tsv
    - |
      VERDICT_ENCODING=token \
        bun "$M7"/reference/comment-resolution/normalize-thread-states.ts \
        mr-thread-rows.tsv > mr-threads.txt
    - THREADS=mr-threads.txt bun "$M7"/reference/comment-resolution/check-threads-resolved.ts
```

## Forges — lifecycle primitives + thread-state export

| Forge | Draft PR | Human-only merge | Thread state → gate input |
|-------|----------|------------------|---------------------------|
| GitHub | native draft PRs | branch protection: required reviews + required checks, no self-merge of bot PRs | GraphQL `pullRequest.reviewThreads` → rows of (`id`, `isResolved`, reply body), one per reply, newest first |
| GitLab | `Draft:` title prefix | protected branch + "all threads resolved" + approval rules | `merge_requests/:iid/discussions` (`id`, `resolved`, `resolvable`, every note) → same rows |
| Gitea / Forgejo | native draft PRs | branch protection + required approvals | conversations API → same rows |

Every forge gives the same three things and nothing more: an id, a resolved
boolean, and free-text replies. Turning those into the gate's
`addressed | rejected | deferred | moot | unclassified | open` states is a
**separate, checked-in step** —
[`normalize-thread-states.ts`](reference/comment-resolution/normalize-thread-states.ts),
shown in the export recipes above. An unresolved thread emits `open` whatever its
last reply says.

Keep the API call and the decode step apart. It is tempting to collapse them into
one clever `jq` filter that emits the reply body straight after the id, but the
gate reads the **first whitespace-delimited token** as the state, so a body like
`**accepted** — fixed in a1b2c3d` arrives as the state `**accepted**` and fails as
an unknown state. Every documented encoding fails that way, which is worse than
useless: the gate reports typo'd resolutions on threads that were resolved
correctly.

**`isOutdated` is deliberately not fetched.** GitHub can tell you a thread's
anchored lines have changed, and it is tempting to map that to `moot`
automatically. Don't: that is precisely the inference core piece 6 forbids. Code
moving is not the same claim as "this finding no longer applies", and the author
is the one who knows which. Treat an outdated thread as a **prompt** to consider
`moot` — worth surfacing in a review UI or a resolve-comments skill — never as
the verdict itself.

### Encoding the declared verdict

Core piece 6 says the author *declares* the terminal state rather than leaving
it to be inferred. Every forge here exposes thread replies as free text and none
has a native verdict field, so the encoding is a convention on the reply body —
but a **checkable** one, and each of these has an exporter setting that actually
decodes it:

| Encoding | Looks like | Exporter |
|----------|-----------|----------|
| Leading token | `**accepted** — added the guard in a1b2c3d` | `VERDICT_ENCODING=token` (the default). Emphasis markers and trailing punctuation are stripped; the anchor is the position, not the bold |
| Trailing trailer | `… Verdict: deferred` as the last thing in the reply | `VERDICT_ENCODING=trailer`. Flattening a multi-line reply turns "on its own line" into "at the end of the body", so the trailer has to be last |
| Forge label / emoji | a reaction or thread label | **not shipped** — no forge above models a verdict field. If yours does, fetch it and extend the exporter's `canon()`; a real field beats any body convention |

**Jig takes no position on which of the two.** `token` is the exporter's
*default*, not a recommendation — it is the form the
[`resolve-review-comments`](../../plugin/skills/resolve-review-comments/README.md)
skill writes, and it has not run through enough review cycles to be called
settled (see the [README](README.md#the-verdict-encoding)). Both are one variable apart,
deliberately, so an adopter picking the other is not fighting the module. What
Jig does assert is the pair of properties below; those are what the
evidence supports, and they hold for any encoding including a forge field that
makes this whole section unnecessary.

Whichever you pick, two properties do the work:

- **Anchored** — matched at a fixed position (start of body, or end of body),
  not "somewhere in the text". An unanchored match reads narration as a
  verdict: a reply explaining *why* something was intentional will contain the
  word "intentional" long after its actual verdict. The exporter's self-test
  pins this down in both directions.
- **Enforced at write time** — validate in whatever posts the reply, so a
  missing verdict fails immediately rather than becoming an unclassifiable row
  at export. Enforcement after the fact cannot recover a verdict nobody wrote.
  This is why the write-time criterion in
  [`maturity.yaml`](maturity.yaml) sits a rung above the convention.

Adopters whose tooling emits different words (`accepted` for `addressed`,
`obsolete` for `moot`) map them in the exporter's `canon()`, whose synonym
table is `verdicts` in [`lib/module-gates.ts`](../../lib/module-gates.ts) — the exporter is
already forge- and repo-specific, and the gate's vocabulary stays closed so a
typo'd resolution still fails.

Provide an explicit opt-out (a flag on the posting tool) for replies that are
genuinely not a verdict — a clarifying question mid-thread. Without one, authors
invent a token to satisfy the check, which is worse than an honest abstention.

Expect a **legacy tail**: replies written before the convention, and opt-out
replies, will never carry a token. Those export as `unclassified`, which is its
own state and fails with its own message rather than being folded into a real
one — an abstention counted as a rejection is the same corruption as a `moot`
counted as a rejection, one layer down. Keep whatever prose heuristic you have as
a fallback for the tail, but keep it *outside* the exporter, and never let it
produce a state it is not sure of.

### Round convergence — producing the status file

The [convergence gate](reference/review-convergence/) reads three scalar keys plus
one `reviewer:` line per reviewer.

| Key | GitHub | GitLab |
|-----|--------|--------|
| `pr_state` | `gh pr view <n> --json state -q '.state \| ascii_downcase'` | `glab mr view <n>` → `state` (`opened` → `open`) |
| `open_threads` | the number of rows the unresolved-threads gate rejects in `pr-threads.txt` | same, from `mr-threads.txt` |
| `round` | the loop's own counter, incremented per push | same |
| `reviewer: <id> <reported\|pending>` | one line per expected reviewer — see below | same |

Count `open_threads` as the rows the unresolved-threads gate *rejects*, not the
rows whose state is literally `open`. A trail-less `moot` and an `unclassified`
reply are both still work; counting only `open` reads them as convergence and
lets the loop stop on a PR that cannot merge.

**Enumerate reviewers by identity, and settle each one exactly once.** This is
the step where a producer silently breaks the gate, so it is worth spelling out.

The expected set is **the reviewers actually scheduled for this PR**, named
individually. It is *not* the row list of
[`review-config.yaml`](templates/review-config.yaml), and reading it that way
wedges the loop at `WAIT` forever:

- That registry contains **category rows, not identities** — the shipped config has
  `- id: humans` (`kind: human`), which stands for "whichever humans M3 selects".
  No artifact can ever settle an identity literally named `humans`, so expand it to
  the concrete reviewers the PR requested and drop the row itself.
- It contains reviewers that are **not running on this PR**: `enabled: false`
  entries, and tools scoped to change-areas this PR does not touch. A reviewer that
  was never invoked has nothing to report and will never report it.

So: expected = (automated reviewers with `enabled: true` **that this PR actually
invoked**) + (the concrete human identities **currently** on the hook). If a
reviewer is not going to run, it does not belong in the census at all — leaving it
in is indistinguishable from waiting for it forever.

Two ways to get that union wrong, both of which park the loop at `WAIT` for good:

The rule that makes this correct by construction: a human is on the hook for this
round if they are **currently requested**, or if they have **already submitted for
the current head**. Nothing else belongs in the census — and note that the second
half is exactly `settled_for_head`, so deriving it from that same predicate means
the census and the settle check cannot disagree about anybody.

```sh
# Still-pending requests.
requested=$(gh pr view "$PR" --json reviewRequests -q '.reviewRequests[].login')

# Reviewers who have already reported ON THIS HEAD. Filtering through
# `settled_for_head` rather than trusting a review's mere existence is what keeps a
# stale reviewer out: with stale-review dismissal disabled, someone who reviewed an
# earlier head is still in `latestReviews` and not `DISMISSED`, and adding them to
# the census while `settled_for_head` refuses to settle them parks the loop at WAIT
# for good.
already=$(gh pr view "$PR" --json latestReviews \
            -q '.latestReviews[] | select(.state != "DISMISSED") | .author.login' \
          | while read -r id; do settled_for_head "$id" "$head_sha" && echo "$id"; done)

# Dedupe the COMBINED set, bots first. A bot that both registers a check and posts a
# review appears in more than one source, and per-source `unique` cannot see that —
# two identical `reviewer:` lines make the gate exit 2 on a duplicate identity
# instead of deciding.
EXPECTED_REVIEWER_IDS=$(printf '%s\n' $(invoked_bot_ids) $requested $already \
                        | awk 'NF && !seen[$0]++')
```

Deciding whether each of those has reported means looking at what that reviewer
leaves behind, and reviewers do not leave the same things:

| Reviewer kind | Settled when | Where to look |
|---------------|--------------|---------------|
| bot registering a check | its check run concludes | `gh pr checks <n>` / pipeline job status |
| bot posting comments only | it has posted for the current head sha | its review/comment timestamps vs. the head sha — a comment-only bot is **invisible** to `gh pr checks` |
| human reviewer | a review is submitted for the current head sha | `gh pr view <n> --json reviews` / MR approvals + notes |

The trap: a bot that does **both** — registers a check *and* posts a review — is
two settled signals for one reviewer. Sum signals and you get "2 of 2 reported"
with one bot finished and a human who has not looked, which is the early stop the
gate exists to prevent. So key the derivation on the **identity**: build a
`reviewer:` line per expected reviewer, never one per artifact found. The gate
rejects a repeated identity rather than counting it twice, which is what turns a
producer bug into a visible error instead of a false `CONVERGED`.

Resolve ties toward **`pending`**. Every mistake in the optimistic direction ends
the loop early and silently; a mistake in the pessimistic direction costs one
extra round.

**Do not let the thread count swallow the gate's own failure.** The tempting
one-liner — `check-threads-resolved.ts … | grep -c '^FAIL' || true` — pipes the
gate's stdout into `grep` and then masks every nonzero status. If the states file
is missing, unreadable, or malformed, the gate exits **2** with empty stdout, the
count comes out **0**, and the convergence gate cheerfully reports `CONVERGED` on
an export that never happened. Capture the gate's status first and treat 2 as
fatal; only exit 0 and 1 are answers.

Capture it with `&& rc=0 || rc=$?`, not `cmd; rc=$?`. Under the `set -e` the loop
recipe below recommends, a bare assignment from a command substitution aborts the
shell on the gate's *ordinary* exit 1 — every normal `WORK` round would kill the
driver before the status could be classified.

```sh
gate_out=$(bun "$M7"/reference/comment-resolution/check-threads-resolved.ts pr-threads.txt) \
  && gate_rc=0 || gate_rc=$?
case "$gate_rc" in
  0) threads=0 ;;                                          # every thread terminal
  1) threads=$(printf '%s\n' "$gate_out" | grep -c '^FAIL') ;;
  *) echo "$gate_out" >&2
     echo "ERROR: thread-state export or gate failed (exit $gate_rc) — not a converged round" >&2
     exit "$gate_rc" ;;
esac
head_sha=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
{
  echo "pr_state: $(gh pr view "$PR" --json state -q '.state | ascii_downcase')"
  echo "open_threads: $threads"
  echo "round: $ROUND"
  # One line per EXPECTED reviewer identity — see § Enumerate reviewers, above.
  # `settled_for_head <id>` is your repo's per-reviewer rule from the table there;
  # it must answer for THIS head sha, or a reviewer that reported one push ago
  # counts as having reviewed the current code.
  for id in $EXPECTED_REVIEWER_IDS; do
    if settled_for_head "$id" "$head_sha"; then echo "reviewer: $id reported"
    else                                        echo "reviewer: $id pending"; fi
  done
} > round-status.txt
```

Note the head-sha condition in that loop. "Has this reviewer reported?" without it
means "ever", so every reviewer stays settled from round 2 onward and the gate
converges on the first round with no open threads — the early stop, reintroduced
one layer down.

### Making the decision the loop's control flow

Running the gate and keeping its output is not the same as obeying it. `WORK`,
`WAIT` and `ABORT` exit **1**, **3** and **4** on purpose: under `set -e` the loop
dies at this line, and without `set -e` it slides past as though the four
decisions were interchangeable. Dispatch on the status explicitly — that dispatch
*is* the mechanism the maturity criterion asks for.

```sh
set -euo pipefail
bun "$M7"/reference/review-convergence/check-round-converged.ts round-status.txt > decision.txt \
  && decision_rc=0 || decision_rc=$?
cat decision.txt          # keep it: M8's reflection trigger reads this file

case "$decision_rc" in
  0)  # CONVERGED — the only state in which the loop may stop.
      run_reflection_trigger ;;                 # see M8's mappings.md
  1)  # WORK — resolve every thread, declare each verdict, push, run round N+1.
      resolve_threads && git push && exec "$0" "$((ROUND + 1))" ;;
  3)  # WAIT — a reviewer is still running. Do NOT stop and do NOT push;
      #        sleep and re-poll, so the round's comments can arrive.
      sleep "$POLL_SECONDS"; exec "$0" "$ROUND" ;;
  4)  # ABORT — the PR is merged or closed. Stop without pushing: anything
      #        committed from here lands on a branch nothing will merge.
      echo "PR is no longer open — abandoning the loop" >&2; exit 0 ;;
  *)  echo "convergence gate failed (exit $decision_rc)" >&2; exit "$decision_rc" ;;
esac
```

The `WAIT` branch is the one worth getting right, and the easy mistake is to make
it identical to `WORK`. Pushing on `WAIT` restarts the reviewers you were waiting
for, so the round you were about to receive never arrives; the loop can spin like
that indefinitely while looking busy. `WAIT` waits.

The decision line is also
[M8](../M8-learning-loop/)'s
[reflection trigger](../M8-learning-loop/reference/reflection-trigger/) input, so
keep `decision.txt` around for that step.

## Stacked pull requests

A stack is only safe when every tool that reads settings from a PR's base can
work out where the stack finally lands. The options differ in where that
answer lives:

| Option | How a layer is opened | Where the final target is recorded | What base-scoped tools must do |
|--------|-----------------------|------------------------------------|--------------------------------|
| No stacking | Every PR targets the integration branch | The base itself | Nothing |
| GitHub native stacks | `gh pr create --base <predecessor branch>`, then link it with the [gh-stack](https://github.com/github/gh-stack) extension: `gh stack link <stack number> <new>` to append to an existing stack (only on its top), or `gh stack link --base <trunk> <bottom> … <predecessor> <new>` to start one, each pull request by URL (a bare number that is also a local branch's name is read as that branch and pushed); `gh stack submit` for a whole local stack | GitHub's stack record (its Stacks API), merged members included; each layer's base is still its predecessor's branch, and only the bottom layer targets the trunk | Read the stack record; a walk of open PRs misses merged members and upper layers |
| Graphite | `gt create`, `gt submit` | Graphite's own stack record; on the forge, a plain branch chain | Walk the chain, or read Graphite's record |
| [ghstack](https://github.com/ezyang/ghstack) | `ghstack` (submit) | Nowhere on the forge: each PR targets its own synthetic `gh/<user>/<n>/base` branch, which no open PR owns, and `ghstack land` lands the commits on the trunk | Recognise the `gh/<user>/<n>/base` pattern as "lands on the trunk"; a walk of open PRs stops at the first synthetic base |
| git-town, Sapling, Jujutsu | Each tool's submit command | A plain branch chain on the forge | Walk the chain |
| Plain branch chaining | `gh pr create --base <predecessor branch>` | Nowhere: only the chain of open PRs, head to base | Walk the chain: each hop is the one open, same-repository PR whose head is the current branch, until the trunk |
| GitLab | `glab stack` (stacked diffs), or merge requests targeting a predecessor's branch | Per merge request, the target branch | Walk the chain |
| Gerrit | A relation chain of dependent changes | The chain's target branch, on every change | Nothing |

A plain chain breaks when a lower layer merges and its branch is kept: the
layer above then targets a branch no open PR owns. GitHub retargets the
dependent PR automatically only when the merged head branch is deleted, so a
repository that allows plain chains should turn on "Automatically delete head
branches".

## Review bots / harness (the tool registry)

Each reviewer is one entry in [`review-config.yaml`](templates/review-config.yaml)
with a `posture`. New reviewers enter **comment-only**; promotion to blocking is
[HITL](../../GLOSSARY.md) and gated on measured precision ([M8](../M8-learning-loop/)).
The config's `review_source` records where the authoritative runtime and policy
come from. A checked-in config can change in a PR, but the review of that PR
reads the target base branch's copy.

| Reviewer | Role | Typical posture |
|----------|------|-----------------|
| In-house [shadow reviewer](../../GLOSSARY.md) (this harness) | additive numbered lenses, grown by the learning loop | comment-only until its bar clears |
| CodeRabbit / Greptile / other commercial bot | static-analysis + AST depth | comment-only until it clears the same measured-precision bar |
| Agent-runtime reviewer (Claude Code / Codex / Cursor `/review`) | on-demand local tiered review before pushing | advisory / author-side |
| Humans | judgment + sign-off; selected per change-area | authoritative (a "request changes" blocks) |

## CI providers

Any provider works — the gates use Bun and TypeScript. The only provider-specific
piece is the thread-state export step (a forge API call), shown above for
GitHub Actions and GitLab CI.

## Issue trackers

| Tracker | Wiring |
|---------|--------|
| GitHub / GitLab issues | a `hitl` label revokes autonomous merge for the linked PR; a PR-template checkbox "threads resolved / follow-ups filed" |
| Linear / Jira | a `hitl` label (see [M0](../M0-instruction-architecture/) / [M9](../M9-tasks-memory/)) marks a deliverable whose merge stays human; deferred threads become linked follow-up issues, whose ids are the `deferred` gate's trail |

The human checkpoints (**merge**, **promote a reviewer to blocking**) are
enforced by forge settings + the [HITL registry](templates/HITL-REGISTRY.md),
not by a script — a bot must not hold those. **Mark Ready** is the one
checkpoint a repository may delegate: an unattended review driver such as
Jig's `drive-pr` marks a draft Ready at the point
`pull_requests.mark_ready` declares (after its first review round by default,
after a later round, or only at convergence), so reviewers that skip drafts
spend their pass on a head the draft-reviewing reviewer has already cleaned. The driver's opt-out
(`--keep-draft`) keeps the step human.
