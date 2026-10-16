# M10 mappings — per-ecosystem implementations

The module [invariant](README.md) — four stages, an explicit `verified` pointer,
a watchdog that decides why the pointer lags, verified-only deploys, a manual
gated promotion that ships what it gated — is tool-independent. This file maps its mechanisms onto
concrete [CI](../../GLOSSARY.md) providers, preview-environment platforms,
promotion gates, and the promotion-execution tools (registries,
[GitOps](../../GLOSSARY.md) controllers, rollout checks). Replace `<placeholders>` with your values. Install the pinned Bun runtime
before the commands below; the module gates and tests require Bun.

## The two gates, per rung

| Gate | Local (hook) | CI (authority) |
|------|--------------|----------------|
| Promote-safety lint | pre-commit over the deploy workflows (optional) | blocking on any PR that touches the deploy workflows — the workflows are the thing checked |
| Verified-pointer watchdog | n/a (needs live pointer, run and queue state) | scheduled job on another runner pool; heals a dropped trigger within a budget of attempts and cancels a stalled run; fails on the faults a person must repair (ran but stale, a stalled queue, a diverged pointer, heals exhausted, an observation it cannot read); passes running verification, failed gates and a documentation-only gap |

The watchdog is a *scheduled* job, not a per-PR gate — it watches a
background process (verification keeping up), not a diff, exactly as
[M8](../M8-learning-loop/)'s parity report is scheduled rather than per-PR.

One thing the promote-safety example must get right and you must not drop:

- **Run the lint from the BASE, not the PR checkout.** A merge-blocking lint that
  runs out of the PR's own checkout is not a gate — the PR can edit the script
  (or the workflow) to report success. Check the PR's tree out as *data* to be
  scanned, and run the gate script from a separately checked-out base tree the PR
  cannot alter (or a pinned reusable workflow). Set one `M10` variable to wherever
  you vendored the module and build every path from it. This is the same
  base-not-head discipline as [M7](../M7-pr-lifecycle-review/)'s reviewer lint.

### GitHub Actions

```yaml
# .github/workflows/deploy-safety.yml — lints the deploy workflows on every PR
on:
  pull_request:
    paths: [".github/workflows/**"]
jobs:
  promote-safety:
    runs-on: ubuntu-latest
    env:
      M10: base/modules/M10-environments-deploy    # gate scripts, from the base tree
    steps:
      - uses: actions/checkout@<full-commit-sha>    # v4; PR tree — scanned as DATA
        with: { path: pr }
      - uses: actions/checkout@<full-commit-sha>    # v4; BASE tree — owns the gate
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
      - name: Production deploys are gated + verified-only (blocking)
        run: WORKFLOWS_DIR=pr/.github/workflows bun "$M10"/reference/promote-safety/check-promote-safety.ts
      - name: Gate self-tests (blocking)
        run: |
          bun test "$M10"/reference/promote-safety/check-promote-safety.test.ts
          bun test "$M10"/reference/verified-pointer/check-verified-fresh.test.ts
```

### GitLab CI

```yaml
promote_safety:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]
  variables:
    # Gate scripts MUST come from the BASE the MR targets, never the MR's own
    # tree — a fork MR can edit its own copy of the gate to report success.
    # Extract the base copy of the module and point M10 at THAT; the MR's
    # workflow files are scanned only as data.
    M10: base/modules/M10-environments-deploy
  before_script:
    - git fetch --depth=1 origin "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
    - mkdir -p base && git archive "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
        modules/M10-environments-deploy | tar -x -C base
  script:
    # scan the MR's own deploy workflows (data) with the trusted base-tree gate
    - WORKFLOWS_DIR=.gitlab/deploy bun "$M10"/reference/promote-safety/check-promote-safety.ts
    - bun test "$M10"/reference/promote-safety/check-promote-safety.test.ts
    - bun test "$M10"/reference/verified-pointer/check-verified-fresh.test.ts
```

## The verified-pointer watchdog

The [decision](README.md#the-watchdog-decides-by-cause) is provider-neutral
and lives in [`reference/verified-pointer/`](reference/verified-pointer/);
what differs per provider is the *collector* that observes the pointer, the
tip's verification runs and the runner queue, and the two actions, a
dispatch and a cancel. Every read in the collector fails closed: an ancestry
check or a diff that errors is not "no", a run listing that fails or is cut
short is not "no runs", and a run status the collector does not know is an
error, not "running". The collector reads only the integration branch's own
verification runs, and observes again when the pointer moved while it read
them, since a run that just advanced the pointer would otherwise read as
"verified but not moved".

### Verification covers the whole gap

The watchdog's heal and cancel are safe only when each verification run
checks the whole `verified..tip` range.

| Concern | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| The range a run checks | the change-detection step diffs the pointer against the head (`git diff --name-only refs/remotes/origin/verified HEAD`, or the change-area resolver run against the pointer), never `HEAD~1 HEAD` | the same diff in the verification job, with the pointer fetched first (`git fetch origin verified`) |
| One run at a time, superseded runs dropped | `concurrency: { group: verify-${{ github.ref == 'refs/heads/<branch>' && '<branch>' || github.run_id }}, cancel-in-progress: false }`: pushes to the integration branch share one slot (one pending run survives, and it covers the range), while a dispatch from any other ref gets its own group so it cannot displace a push | `resource_group: verify` on the verification job with `process_mode: oldest_first`; waiting jobs are not dropped, so the advance step must only ever move the pointer forward ([M13's mapping](../M13-pipeline-economy/mappings.md#supersede)) |
| The heal can start it | `on: workflow_dispatch` beside `on: push`; the jobs that package and advance run on either event, gated on the integration branch (`github.ref == 'refs/heads/<branch>'`) | a pipeline created through the API (`POST /projects/:id/pipeline?ref=<branch>`) runs the same jobs as a push |

### GitHub Actions

```yaml
# .github/workflows/verified-watchdog.yml — why does the pointer lag?
on:
  schedule: [{ cron: "*/15 * * * *" }]
  workflow_dispatch:
concurrency:
  # Scheduled ticks cover one another; a manual run keeps a group of its own.
  group: verified-watchdog-${{ github.event_name == 'schedule' && 'schedule' || github.run_id }}
  cancel-in-progress: true
permissions:
  contents: read
  actions: write                              # dispatch verification, cancel a stalled run
jobs:
  watchdog:
    runs-on: <a pool other than the one verification runs on>
    timeout-minutes: 10
    env:
      M10: modules/M10-environments-deploy     # where you vendored the module
      VERIFY_WORKFLOW: verify.yml              # the post-merge verification workflow
      BRANCH: <integration branch>
      POINTER: refs/heads/verified             # or refs/tags/verified
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@<full-commit-sha>  # v4
        with: { fetch-depth: 0 }
      - name: Observe the pointer, the tip and the queue
        id: observe
        run: |
          set -euo pipefail
          for ATTEMPT in 1 2 3; do
            git fetch --quiet origin "+$POINTER:refs/watchdog/verified" "+refs/heads/$BRANCH:refs/watchdog/tip"
            VERIFIED=$(git rev-parse refs/watchdog/verified); TIP=$(git rev-parse refs/watchdog/tip)
            # Only exit 1 means "not an ancestor" (or "differs" below); any other exit is the check failing.
            rc=0; git merge-base --is-ancestor "$VERIFIED" "$TIP" || rc=$?
            [ "$rc" -le 1 ] || { echo "::error::merge-base exited $rc"; exit 1; }
            ANCESTOR=$([ "$rc" -eq 0 ] && echo yes || echo no)
            echo "ANCESTOR $ANCESTOR" > observation.txt
            # The whole range, against the paths verification builds or tests.
            rc=0; git diff --quiet "$VERIFIED" "$TIP" -- . ':(exclude)docs/' ':(exclude)*.md' || rc=$?
            [ "$rc" -le 1 ] || { echo "::error::git diff exited $rc"; exit 1; }
            if [ "$ANCESTOR" = no ]; then
              :  # A diverged pointer is decided on ancestry and the queue alone: it has no age to read.
            elif [ "$rc" -eq 0 ]; then
              echo "CODE_AHEAD no" >> observation.txt
            else
              echo "CODE_AHEAD yes" >> observation.txt
              # Age from when the oldest code-bearing change the pointer lacks reached the
              # branch, as the forge recorded it: a commit's own timestamp says when it was
              # written, and a fast-forward lands an old commit at once. Arrivals are read
              # newest first back to one the pointer already holds; one whose commit is not
              # in the tip's history (deleted, force-pushed away) is skipped, and a listing
              # that ends before reaching the pointer fails, rather than ageing too young.
              # GitHub's activity log records every push and merge to the branch.
              gh api --paginate "repos/$GITHUB_REPOSITORY/activity?ref=refs/heads/$BRANCH&per_page=100" \
                --jq '.[] | "\(.after)\t\(.timestamp | sub("\\.[0-9]+"; "") | fromdateiso8601)"' > arrivals.tsv
              ARRIVED=; REACHED=no
              while IFS=$'\t' read -r AFTER AT; do
                git cat-file -e "$AFTER^{commit}" 2>/dev/null || continue
                rc=0; git merge-base --is-ancestor "$AFTER" "$VERIFIED" || rc=$?
                [ "$rc" -le 1 ] || { echo "::error::merge-base exited $rc"; exit 1; }
                [ "$rc" -eq 0 ] && { REACHED=yes; break; }
                rc=0; git merge-base --is-ancestor "$AFTER" "$TIP" || rc=$?
                [ "$rc" -le 1 ] || { echo "::error::merge-base exited $rc"; exit 1; }
                [ "$rc" -eq 0 ] || continue
                rc=0; git diff --quiet "$VERIFIED" "$AFTER" -- . ':(exclude)docs/' ':(exclude)*.md' || rc=$?
                [ "$rc" -le 1 ] || { echo "::error::git diff exited $rc"; exit 1; }
                [ "$rc" -eq 0 ] || ARRIVED=$AT
              done < arrivals.tsv
              [ "$REACHED" = yes ] && [ -n "$ARRIVED" ] || { echo "::error::no recorded arrival for the unverified change"; exit 1; }
              echo "UNVERIFIED_AGE_SECONDS $(( $(date -u +%s) - ARRIVED ))" >> observation.txt
              # The tip's verification runs on the integration branch, started by a
              # push or a dispatch: a run of another ref at the same commit has its
              # own concurrency group and skips the advance. Every page is read, and
              # a listing GitHub caps at 1,000 runs fails rather than leaving runs out.
              gh api --paginate "repos/$GITHUB_REPOSITORY/actions/workflows/$VERIFY_WORKFLOW/runs?head_sha=$TIP&branch=$BRANCH&per_page=100" \
                --jq 'if .total_count > 1000 then error("over 1000 runs at the tip") else .workflow_runs[] end' > runs.json
              # The listing shows each run's newest attempt only: read every earlier
              # attempt of a re-run run too, so a success a re-run followed is kept.
              jq -r 'select(.run_attempt > 1) | "\(.id)\t\(.run_attempt)"' runs.json > rerun.tsv
              while IFS=$'\t' read -r RUN N; do
                for ((A = 1; A < N; A++)); do gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN/attempts/$A"; done
              done < rerun.tsv > attempts.json
              # Only the statuses and conclusions named here count; any other fails
              # the step. A success in any attempt is sticky; the newest attempt of
              # each run says whether it is still running, and the newest run tells
              # a failure from an aborted run. HEAL_ATTEMPTS counts each dispatched
              # run once, when its newest attempt ended without a verdict.
              jq -rs --arg branch "$BRANCH" '
                def state:
                  if .status == "completed" then
                    {success: "succeeded", failure: "failed", cancelled: "aborted", timed_out: "aborted",
                     skipped: "aborted", stale: "aborted", startup_failure: "aborted"}[.conclusion // ""]
                      // error("unknown conclusion: \(.conclusion)")
                  elif (.status | IN("requested", "queued", "pending", "waiting", "in_progress")) then "running"
                  else error("unknown status: \(.status)") end;
                [.[] | .state = state | select(.head_branch == $branch and (.event | IN("push", "workflow_dispatch")))] as $all
                | [$all | group_by(.id)[] | max_by(.run_attempt)] as $r
                | (if any($r[]; .state == "running") then "running"
                   elif any($all[]; .state == "succeeded") then "succeeded"
                   elif ($r | length) == 0 then "none"
                   else $r | sort_by(.updated_at) | last | .state end) as $v
                | "VERIFICATION \($v)",
                  "HEAL_ATTEMPTS \([$r[] | select(.event == "workflow_dispatch" and .state == "aborted")] | length)"
              ' runs.json attempts.json >> observation.txt
            fi
            # Verification can advance the pointer while its runs are read: observe again.
            git fetch --quiet origin "+$POINTER:refs/watchdog/verified"
            [ "$(git rev-parse refs/watchdog/verified)" = "$VERIFIED" ] && break
            [ "$ATTEMPT" -lt 3 ] || { echo "::error::the pointer moved during three observations"; exit 1; }
          done
          # The runs that can hold the slot: the branch's queued, in-progress and
          # waiting runs, each listing read in full. Only a job still `queued` waits
          # for a runner (a job waiting for an approval is `waiting`, not a stall);
          # a queued run with no jobs yet counts from its last update. A job status
          # outside the known ones fails the step rather than reading as no wait.
          for STATUS in queued in_progress waiting; do
            export STATUS
            gh api --paginate "repos/$GITHUB_REPOSITORY/actions/workflows/$VERIFY_WORKFLOW/runs?branch=$BRANCH&status=$STATUS&per_page=100" \
              --jq 'if .total_count > 1000 then error("over 1000 runs are \(env.STATUS)") else .workflow_runs[] | [.id, .status, .updated_at] | @tsv end'
          done > holders.tsv
          WAIT=0; HOLDER=""
          while IFS=$'\t' read -r RUN STATUS UPDATED; do
            gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$RUN/jobs?filter=latest&per_page=100" --jq '.jobs[]' > jobs.json
            W=$(jq -rs --argjson now "$(date -u +%s)" --arg status "$STATUS" --arg updated "$UPDATED" '
              if any(.[]; .status | IN("requested", "queued", "pending", "waiting", "in_progress", "completed") | not)
              then error("a job status outside the known ones: \([.[].status] | unique)")
              elif length == 0 and $status == "queued" then $now - ($updated | fromdateiso8601)
              else [.[] | select(.status == "queued") | $now - (.created_at | fromdateiso8601)] | max // 0 end' jobs.json)
            if [ "$W" -gt "$WAIT" ]; then WAIT=$W; HOLDER=$RUN; fi
          done < holders.tsv
          echo "QUEUE_WAIT_SECONDS $WAIT" >> observation.txt
          echo "holder=$HOLDER" >> "$GITHUB_OUTPUT"
      - name: Decide
        id: decide
        continue-on-error: true                 # the steps below act; the last one fails the job
        run: bun "$M10"/reference/verified-pointer/check-verified-fresh.ts --max-heal-attempts 3 --output "$GITHUB_OUTPUT" observation.txt
      - name: Cancel the run stalled in the runner queue
        if: steps.decide.outputs.queue == 'stalled'
        env:
          HOLDER: ${{ steps.observe.outputs.holder }}
        run: gh run cancel "${HOLDER:?no run holds the slot}"
      - name: Heal a dropped trigger
        id: heal
        if: steps.decide.outputs.pointer == 'dropped-trigger'
        run: gh workflow run "$VERIFY_WORKFLOW" --ref "$BRANCH"
      - name: Fail on everything a person must see
        # A heal that was dispatched, with a healthy queue, is the one failing verdict that stays green.
        if: steps.decide.outcome != 'success' && !(steps.heal.outcome == 'success' && steps.decide.outputs.queue == 'ok')
        run: exit 1
```

Each listing is read in full: `--paginate` follows every page, and a search
GitHub caps at 1,000 runs fails the step instead of leaving runs out, as in
[M13's queue watchdog](../M13-pipeline-economy/templates/queue-watchdog.yml).
A failed cancel or dispatch fails its own step, and so the job; the job stays
green only when the dispatch succeeded. A heal runs as a `workflow_dispatch`
run on the integration branch, which is what `HEAL_ATTEMPTS` counts, each
run once by its newest attempt; a success in an earlier attempt stays a
success, so a cancelled re-run cannot turn it into a heal. Once
`--max-heal-attempts` dispatched runs at the same tip have ended without a
verdict, the check answers `pointer=heal-exhausted` and the job fails instead
of dispatching again.

### GitLab CI

```yaml
verified_watchdog:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]
  tags: [<a runner other than the ones verification uses>]
  timeout: 10m
  variables:
    M10: modules/M10-environments-deploy
    BRANCH: <integration branch>
    POINTER: refs/heads/verified               # or refs/tags/verified
    VERIFY_JOB: <verification job>             # the job whose success lets the pointer advance
    GIT_DEPTH: 0                               # ancestry needs the whole history
  script:
    - |
      set -euo pipefail
      API="$CI_API_V4_URL/projects/$CI_PROJECT_ID"
      api() { curl -fsS --connect-timeout 10 --max-time 60 --header "PRIVATE-TOKEN: $WATCHDOG_TOKEN" "$@"; }
      # Every page of a listing, as one JSON array. A page without the
      # x-next-page header cannot say whether more follow, so it fails.
      list() {
        local page=1; : > pages.json
        while [ -n "$page" ]; do
          api -D headers.txt "$API/$1&per_page=100&page=$page" >> pages.json
          grep -qi '^x-next-page:' headers.txt || { echo "no x-next-page header: $1" >&2; exit 1; }
          page=$(awk -F': *' 'tolower($1) == "x-next-page" { sub(/\r$/, "", $2); print $2 }' headers.txt)
        done
        jq -s 'if all(.[]; type == "array") then add // [] else error("not a listing") end' pages.json
      }
      # A shallow clone hides ancestors, and is-ancestor would answer "no".
      [ "$(git rev-parse --is-shallow-repository)" = false ] || git fetch --quiet --unshallow origin
      for ATTEMPT in 1 2 3; do
        git fetch --quiet origin "+$POINTER:refs/watchdog/verified" "+refs/heads/$BRANCH:refs/watchdog/tip"
        VERIFIED=$(git rev-parse refs/watchdog/verified); TIP=$(git rev-parse refs/watchdog/tip)
        # Only exit 1 means "not an ancestor" (or "differs" below); any other exit is the check failing.
        rc=0; git merge-base --is-ancestor "$VERIFIED" "$TIP" || rc=$?
        [ "$rc" -le 1 ] || { echo "merge-base exited $rc" >&2; exit 1; }
        ANCESTOR=$([ "$rc" -eq 0 ] && echo yes || echo no)
        echo "ANCESTOR $ANCESTOR" > observation.txt
        rc=0; git diff --quiet "$VERIFIED" "$TIP" -- . ':(exclude)docs/' ':(exclude)*.md' || rc=$?
        [ "$rc" -le 1 ] || { echo "git diff exited $rc" >&2; exit 1; }
        if [ "$ANCESTOR" = no ]; then
          :  # A diverged pointer is decided on ancestry and the queue alone: it has no age to read.
        elif [ "$rc" -eq 0 ]; then
          echo "CODE_AHEAD no" >> observation.txt
        else
          echo "CODE_AHEAD yes" >> observation.txt
          # Age from when the oldest code-bearing change the pointer lacks reached the
          # branch, as the forge recorded it: a commit's own timestamp says when it was
          # written, and a fast-forward lands an old commit at once. Arrivals are read
          # newest first back to one the pointer already holds; one whose commit is not
          # in the tip's history (deleted, force-pushed away) is skipped, and a listing
          # that ends before reaching the pointer fails, rather than ageing too young.
          # GitLab records every push to the branch, a merge's included, as a push
          # event. Events start two days before the pointer's commit was written,
          # which no arrival after it can precede but by clock skew. A push of more
          # branches than the instance's push-event limit is one bulk event that
          # names none of them: one met before the pointer is reached may hide the
          # branch's arrival, so it fails rather than ageing too young.
          SINCE=$(jq -rn --argjson t "$(git log -1 --format=%ct "$VERIFIED")" '$t - 172800 | strftime("%Y-%m-%d")')
          list "events?action=pushed&after=$SINCE" | jq -r --arg branch "$BRANCH" '.[]
            | select(.push_data.ref_type == "branch" and (.push_data.ref == $branch or .push_data.ref == null))
            | "\(if .push_data.ref == null then "BULK" else .push_data.commit_to end)\t\(.created_at | sub("\\.[0-9]+"; "") | fromdateiso8601)"' > arrivals.tsv
          ARRIVED=; REACHED=no
          while IFS=$'\t' read -r AFTER AT; do
            [ "$AFTER" != BULK ] || { echo "a bulk push event may hide the branch's arrival" >&2; exit 1; }
            git cat-file -e "$AFTER^{commit}" 2>/dev/null || continue
            rc=0; git merge-base --is-ancestor "$AFTER" "$VERIFIED" || rc=$?
            [ "$rc" -le 1 ] || { echo "merge-base exited $rc" >&2; exit 1; }
            [ "$rc" -eq 0 ] && { REACHED=yes; break; }
            rc=0; git merge-base --is-ancestor "$AFTER" "$TIP" || rc=$?
            [ "$rc" -le 1 ] || { echo "merge-base exited $rc" >&2; exit 1; }
            [ "$rc" -eq 0 ] || continue
            rc=0; git diff --quiet "$VERIFIED" "$AFTER" -- . ':(exclude)docs/' ':(exclude)*.md' || rc=$?
            [ "$rc" -le 1 ] || { echo "git diff exited $rc" >&2; exit 1; }
            [ "$rc" -eq 0 ] || ARRIVED=$AT
          done < arrivals.tsv
          [ "$REACHED" = yes ] && [ -n "$ARRIVED" ] || { echo "no recorded arrival for the unverified change" >&2; exit 1; }
          echo "UNVERIFIED_AGE_SECONDS $(( $(date -u +%s) - ARRIVED ))" >> observation.txt
          # The verification job of each pipeline a push, a heal (api) or a person
          # (web) started at the tip on the branch, retried jobs included, so a
          # success a retry followed is kept. This watchdog's own pipeline and
          # other scheduled ones are not verification. A push or web pipeline
          # without the job does not count; a heal without it is a heal that ran
          # no verification, aborted once the pipeline is no longer active.
          list "pipelines?sha=$TIP&ref=$BRANCH" | jq -r --argjson self "$CI_PIPELINE_ID" \
            '.[] | select(.id != $self and (.source | IN("push", "api", "web"))) | [.id, .source, .status, .created_at] | @tsv' > candidates.tsv
          : > runs.json
          while IFS=$'\t' read -r P SOURCE STATUS CREATED; do
            list "pipelines/$P/jobs?include_retried=true" | jq --arg job "$VERIFY_JOB" --arg source "$SOURCE" \
              --argjson pipeline "$P" --arg status "$STATUS" --arg created "$CREATED" '
              [.[] | select(.name == $job) | {pipeline: $pipeline, created_at, status, source: $source}]
              | if length > 0 or $source != "api" then .
                elif $status | IN("created", "waiting_for_resource", "preparing", "pending", "running", "scheduled")
                then [{pipeline: $pipeline, created_at: $created, status: "created", source: $source}]
                else [{pipeline: $pipeline, created_at: $created, status: "skipped", source: $source}] end' >> runs.json
          done < candidates.tsv
          # Only the statuses named here count; any other fails the job. A success
          # in any job, retried or not, is sticky; the newest job of each pipeline
          # says whether it is still running, and the newest of those tells failed
          # from canceled or skipped (aborted). HEAL_ATTEMPTS counts each heal
          # pipeline once, when its newest job ended without a verdict.
          jq -rs '
            def state:
              if IN("created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "canceling") then "running"
              elif . == "success" then "succeeded" elif . == "failed" then "failed"
              elif IN("canceled", "skipped") then "aborted"
              else error("unknown job status: \(.)") end;
            [(add // [])[] | .state = (.status | state)] as $all
            | [$all | group_by(.pipeline)[] | max_by(.created_at)] as $r
            | (if any($r[]; .state == "running") then "running"
               elif any($all[]; .state == "succeeded") then "succeeded"
               elif ($r | length) == 0 then "none"
               else $r | max_by(.created_at) | .state end) as $v
            | "VERIFICATION \($v)",
              "HEAL_ATTEMPTS \([$r[] | select(.source == "api" and .state == "aborted")] | length)"
          ' runs.json >> observation.txt
        fi
        # Verification can advance the pointer while its runs are read: observe again.
        git fetch --quiet origin "+$POINTER:refs/watchdog/verified"
        [ "$(git rev-parse refs/watchdog/verified)" = "$VERIFIED" ] && break
        [ "$ATTEMPT" -lt 3 ] || { echo "the pointer moved during three observations" >&2; exit 1; }
      done
      # The longest a pending verification job on the branch has waited for a runner.
      list "jobs?scope=pending" | jq --arg job "$VERIFY_JOB" --arg ref "$BRANCH" \
        '[.[] | select(.name == $job and .ref == $ref) | {id, wait: (.queued_duration // error("no queued_duration on job \(.id)"))}]' > pending.json
      echo "QUEUE_WAIT_SECONDS $(jq -r 'map(.wait) | max // 0 | floor' pending.json)" >> observation.txt
      HOLDER=$(jq -r 'max_by(.wait) | .id // empty' pending.json)
      rc=0; bun "$M10"/reference/verified-pointer/check-verified-fresh.ts --max-heal-attempts 3 --output verdict.env observation.txt || rc=$?
      [ "$rc" -le 1 ] || exit "$rc"              # the check could not decide
      if grep -qx 'queue=stalled' verdict.env; then
        api -X POST "$API/jobs/${HOLDER:?no job holds the slot}/cancel" > /dev/null
      fi
      HEALED=no
      if grep -qx 'pointer=dropped-trigger' verdict.env; then
        api -X POST "$API/pipeline?ref=$BRANCH" > /dev/null
        HEALED=yes
      fi
      # A heal that was dispatched, with a healthy queue, is the one failing verdict that stays green.
      [ "$rc" -eq 0 ] || { [ "$HEALED" = yes ] && grep -qx 'queue=ok' verdict.env; } || exit 1
  artifacts:
    reports: { dotenv: verdict.env }
```

`$WATCHDOG_TOKEN` is a project access token with `api` scope, since the
job token cannot cancel jobs or create pipelines. The script is one bash block
under `set -euo pipefail`, so a failed read, cancel or dispatch ends the job
red, and the job stays green only after a dispatch the API accepted. Every
listing follows `x-next-page` to its last page, and every request carries a
connect and a total timeout inside the job's own `timeout`. A heal creates an
`api` pipeline on the branch, which is what `HEAL_ATTEMPTS` counts, each
pipeline once whatever its retries, and one that finished without the
verification job counts as ended without a verdict: once
`--max-heal-attempts` of them at the same tip have ended without a verdict,
the check answers `pointer=heal-exhausted` and the job fails instead of
dispatching again. The verdict file is a dotenv report so a later job can
read `queue` and `pointer`.

## Environment hygiene

The [rules](README.md#environment-hygiene) are provider-neutral; what
differs is where a reaper's opt-in lives, how the gap report is triggered,
and how a currency step removes a cell from a matrix.

### Reapers per created resource

| Resource | Expiry and owner written at creation | Reaper |
|----------|--------------------------------------|--------|
| Preview deployment per pull request (Cloudflare Pages, Vercel, Netlify, Render) | the pull request is the owner; the host lists deployments by age | a weekly scheduled workflow with `workflow_dispatch` inputs `keep` (newest N per project) and `dry_run`; it pages through the host's deployment list sorted by creation, deletes beyond `keep` oldest first, and fails on an API error rather than reading it as an empty list. Hosts cap deployments per project, and a project at the cap stops publishing |
| Ephemeral environment (a Kubernetes namespace per branch or run) | an annotation on the namespace, `<org>/expires-at: <ISO 8601, now plus the lease>`, and an owner label, written by the spawner | a `CronJob` or scheduled workflow that deletes namespaces whose annotation has passed, and refuses any namespace without the annotation |
| Test tenant or organization a scenario run created | the run's purpose and bot identity, recorded by the create call | a scheduled janitor matrixed per environment and purpose, each cell authenticating as its own bot identity so it can only ever act on its own; `--dry-run` unless opted in |
| Per-worktree database namespace | a schema comment or registry row with owner and expiry ([M12's reference](../M12-parallel-agent-ergonomics/reference/worktree-namespace/)) | the same reference's decision, run by each owner; the drop commands are in [M12's mappings](../M12-parallel-agent-ergonomics/mappings.md#per-worktree-data-namespaces) |
| Scratch directories and processes a test started | the test runner's per-process scope ([M14](../M14-testing-strategy/README.md)) | the scope's exit handler removes its subtree; a host sweep reaps by the scope's prefix what a killed process left |

The opt-in, per provider:

| Concern | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| Report by default, act on opt-in | `env: APPLY: ${{ (github.event_name == 'schedule' && vars.<REAPER>_AUTO_REAP == 'true') || inputs.apply == true }}`: a scheduled run applies only when the repository variable says so, a manual run only when its own input does; the step passes `--yes` when `APPLY` is true and `--dry-run` otherwise | a scheduled pipeline variable (`REAPER_AUTO_REAP: "true"` on the schedule) or a manual job with `when: manual` and a variable prompt; the same `--yes`/`--dry-run` switch |
| Refuse production | the reaper's own command refuses the production target before anything is rendered, and the production environment's protection admits no reaper workflow | the production `environment:` is protected, and the reaper job carries `rules: - if: $CI_ENVIRONMENT_NAME == "production"` with `when: never` |
| Review apps with a built-in reaper | none built in: the scheduled sweep above | `environment: { on_stop: stop_review, auto_stop_in: 1 week }` stops a review app when its lease passes; the stop job is the reaper |

### The promotion gap

| Concern | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| When it runs | `on: schedule` daily, `on: push` to every pointer branch (`verified`, the release branch, a manifests branch that pins a deploy), and `workflow_dispatch` with optional ref overrides; `concurrency: { group: promotion-gap, cancel-in-progress: true }` collapses rapid pushes, since a later run reads a superset | a scheduled pipeline, with both rules on the report job: `rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }, { if: '$CI_COMMIT_BRANCH =~ /^(verified|release)$/' }]`, so the daily run and a push to a pointer branch each produce the report |
| Reading the refs | `fetch-depth: 0`, then `git fetch origin <pointer>...` for each pointer; a pointer that is a pin (a commit written into a manifest) is resolved from that commit first | the same fetch in the job |
| Publishing | the report to `$GITHUB_STEP_SUMMARY`, the JSON as an artifact (`actions/upload-artifact`, retained a month), and the count to the metrics backend; a tracker document updated in place is optional and keyed by a fixed title so the update is idempotent | the report as a job artifact with `expose_as`, the count to the metrics backend |

### Environment currency

| Concern | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| The floor | a step runs `git log -1 --format=%H -- <dependency paths>` over the check's dependency list and fails closed when a path no longer exists or the log is empty | the same step in a `.pre` stage job |
| The deployed version | read from the environment's pin: the `sha=` token in the manifests branch's head commit, or the identity endpoint the [post-deploy identity check](README.md#post-deploy-identity) reads | the same |
| Removing the cell | the currency job outputs `envs` as a JSON list of the environments that are current, written with `jq -c` so it is always valid JSON; the check job uses `strategy: { matrix: { env: ${{ fromJSON(needs.currency.outputs.envs) }} } }`, so a stale environment has no cell at all (`matrix` is not available in a job-level `if:`, so the cell cannot be skipped there, and a skipped cell would read as green anyway). Actions rejects an empty matrix, so the check job's own `if:`, which is evaluated before the matrix expands, also requires `needs.currency.outputs.envs != ''` and `!= '[]'`: with no current environment the check job is skipped and the currency job's report says why | the check job's `parallel: matrix` is generated by the currency job into a child pipeline (`trigger: { include: { artifact: matrix.yml, job: currency } }`), so a stale environment appears in no cell |
| Not taking the rest down | the check job runs with `if: ${{ !cancelled() && needs.currency.outputs.envs != '' && needs.currency.outputs.envs != '[]' }}`: a failure inside the currency job after it wrote `envs` (its own checkout, its own timeout) still lets the environments it emitted run, since a job's outputs keep what its steps wrote before the failure; a currency job that failed before writing `envs` leaves it empty, so the check job is skipped and the failed currency job is the red signal; a cancelled workflow run stops it | the currency job is not allowed to fail, so its failure stays the pipeline's red signal, and it has `artifacts: { paths: [matrix.yml], when: always }`. Its first step writes a `matrix.yml` holding one job that only reports "no environment confirmed current" (a child pipeline needs at least one job), and it rewrites the file after each environment it confirms, so a failure part-way leaves the environments already confirmed. GitLab uploads no artifacts from a job that times out, `when: always` included, so the confirmation runs under `timeout` a margin shorter than the job's own (`timeout 25m <confirm>` in a job with `timeout: 30m`): a confirmation that runs long fails the script instead, and the upload still happens. The trigger job has `needs: [currency]` and `when: always`, so it runs on whichever file was uploaded even when the currency job failed; `optional: true` would only cover a currency job absent from the pipeline |

## CI providers — the four stages + the `verified` pointer

Any provider works; the four stages are just workflows keyed on different
triggers, and the `verified` pointer is a plain git ref (a branch or tag) the
verify stage advances and the deploy stage reads.

| Provider | Stage 1 (PR gates) | Stage 2 (verify → advance pointer) | Stages 3–4 (deploy / promote gate) |
|----------|--------------------|-------------------------------------|-------------------------------------|
| GitHub Actions | `on: pull_request` | `on: push` to default branch; final step force-updates `refs/tags/verified` | deploy job on `verified` update; `environment:` with required reviewers gates prod |
| GitLab CI | merge-request pipeline | default-branch pipeline; final job moves the `verified` ref | manual (`when: manual`) job in a protected `environment:` |
| Jenkins / Buildkite / `CircleCI` / others | per-PR pipeline | default-branch pipeline advancing a `verified` tag | manual approval step + protected deploy credentials for prod |

The pointer is deliberately a **git ref**, not a database row: it is inspectable
(`git log verified`), diffable, and survives a CI outage. Advance it with a
force-update of a tag (`git tag -f verified <sha> && git push --force origin
verified`) or a fast-forward of a `verified` branch.

## Preview-environment platforms (options)

Disposable per-PR environments. Any of these is one option among several — pick
by where your app already runs; none is required.

| Option | Fit |
|--------|-----|
| Vercel / Netlify / Cloudflare Pages preview deploys | frontend / static / edge apps — a preview URL per PR out of the box |
| Render / Railway / Heroku review apps | full-stack apps with a managed backend + database branch per PR |
| Fly.io / a Kubernetes namespace-per-PR / Argo CD `ApplicationSet` | container apps where you want the preview on the same platform as prod |
| A platform-as-a-service ephemeral environment (self-hosted spawner) | when you already run the infra and want the preview identical to prod |

Whatever the platform, keep the two properties: created on PR open and
**destroyed on PR close** (cattle, not pets), and seeded by the test-data factory
so the preview has realistic data.

## Test-data factory (options)

The contract is seeded + tenant-isolated + resettable; the implementation is
yours. Common building blocks:

| Concern | Options |
|---------|---------|
| Seed | a seed script / factory library (per-language: factory-bot-style builders, fixtures loaders) invoked with a target tenant id |
| Tenant isolation | a schema/namespace per run, a per-PR database branch, or a tenant/org column scoped per environment |
| Reset | transaction rollback per test, a snapshot restore, or a `factory reset --tenant <id>` command that truncates + reseeds |

Keep it a *factory* (programmatic, on-demand), not a checked-in dump: a static
snapshot drifts and becomes another [generated artifact](../../GLOSSARY.md) to
keep fresh.

## Promotion gates (environment protection / manual approval)

Stage 4 must be a human action that cannot auto-fire. The gate is a platform
setting, not a script — the [promote-safety lint](reference/promote-safety/)
checks that the *wiring* (a manual trigger or an `environment:` reference)
exists; the protection rule itself lives in provider config.

| Provider | Manual-gate mechanism |
|----------|------------------------|
| GitHub | a deployment `environment` with **required reviewers** and/or a wait timer; `workflow_dispatch` for the trigger |
| GitLab | a protected `environment` + a `when: manual` job; deploy freezes / approval rules |
| Others (Jenkins / Buildkite / Argo CD) | a manual approval / `block` step, protected prod credentials, or a sync gate requiring sign-off |

The human checkpoint (**promote to production**) is enforced by these settings
plus the [HITL](../../GLOSSARY.md) boundary shared with
[M7](../M7-pr-lifecycle-review/) — a bot must not hold it.

## Promotion execution

The [promotion-execution invariants](README.md#promotion-execution) — the gated
commit is the shipped commit, [build once](../../GLOSSARY.md), post-deploy identity, release state
off the source line — map onto these mechanisms.

### Pass the gated commit from job to job

| Provider | First job resolves and outputs | Later jobs take it |
|----------|--------------------------------|--------------------|
| GitHub Actions | `outputs: { sha: ${{ steps.pin.outputs.sha }} }`, with `echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"` after checking out the pointer | `needs: gate` and `ref: ${{ needs.gate.outputs.sha }}` in `actions/checkout`; the same expression in every command that names the commit |
| GitLab CI | write `GATED_SHA=<sha>` to a dotenv file (plain `NAME=value` lines GitLab turns into variables of later jobs) declared as `artifacts: reports: dotenv:` | `needs: [gate]`; the variable `$GATED_SHA` is set in the later job |
| Others | a pipeline output or artifact holding the commit | read it; never `git fetch origin <branch>` again |

```yaml
# GitHub Actions — the shape the promote-safety lint's rule (c) accepts
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      sha: ${{ steps.pin.outputs.sha }}
    steps:
      - uses: actions/checkout@<full-commit-sha>   # v4
        with: { ref: verified, persist-credentials: false }   # gate code from the trusted ref
      - id: pin
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - run: ./gates/check-promotion.sh            # runs the copy checked out above
  deploy-production:
    needs: gate
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha>   # v4
        with: { ref: "${{ needs.gate.outputs.sha }}" }
      - run: ./deploy --target production --commit "${{ needs.gate.outputs.sha }}"
```

### Run from the trusted ref

The [trusted ref](../../GLOSSARY.md) is the `verified` pointer. A GitHub `workflow_dispatch` run executes the workflow file as it is on the
ref chosen in "Use workflow from" (or `gh workflow run <file> --ref <ref>`);
the default is the default branch. Dispatch promotions with
`--ref verified`, and make that the default of any script or skill that
starts one. Check the gate's code out from `verified` explicitly (as above),
never from `github.ref`. GitLab runs a manual job from the pipeline it belongs
to, so start the promotion from a pipeline on the trusted ref.

A default is not enforcement: an operator can still pick another branch.
Make the platform refuse it:

| Provider | Only the trusted ref reaches production |
|----------|------------------------------------------|
| GitHub Actions | the production environment's **deployment branches and tags** rule set to selected refs, listing only `verified` (a tag rule when the pointer is a tag); a job naming the environment from any other ref fails before it runs |
| GitLab CI | protected variables alone do not restrict the ref: every pipeline on any protected ref (a protected `main` too) receives them. Make `verified` a protected tag or branch and release production's credentials only to it, for example through an ID token (`id_tokens:`) whose cloud-side trust policy admits only the claims `ref` = `verified`, `ref_protected` = `true` and `environment` = `production`; a protected environment limits who may deploy |

### Serialize promotions without dropping one

| Provider | Built-in serialization | What it does to a waiting request | Use |
|----------|------------------------|-----------------------------------|-----|
| GitHub Actions | `concurrency: { group: <key>, cancel-in-progress: false }` | at most one run and **one pending** run per group: a newer pending run cancels the older pending one, whatever its inputs | key the group per run (`group: promote-production-${{ github.run_id }}`) so none is dropped, and serialize with a lock job before the first change: it lists the workflow's active runs, one query per active `status` (`queued`, `in_progress`, `waiting` for an environment approval, `requested`, `pending`), each read in full (`gh api --paginate "repos/<owner>/<repo>/actions/workflows/<file>/runs?status=<status>&per_page=100"`; a single page holds only the newest 30), and proceeds once its own run id is the smallest; a failed query, or a list that does not contain its own run, fails the job rather than proceeding. It also fails a re-run (`github.run_attempt` above 1): a re-run keeps its original, lower run id, so it would count itself earliest while a later promotion is changing production; start a new promotion instead. Repeat the check (fail, don't wait) just before the migration |
| GitLab CI | `resource_group: production` | jobs in the group queue and run one at a time; the process mode `oldest_first` runs them in pipeline order (set through the Resource Groups API, `PUT /projects/:id/resource_groups/:key` with `process_mode=oldest_first`, not in `.gitlab-ci.yml`). The group is held per job: between two jobs of one promotion, a job of another promotion can take it | hold the group across the whole mutating sequence, never on each job separately: put it on the one job that runs every step changing production (migration through the identity check), or on a trigger job (`trigger:` with `strategy: depend`) that runs those steps as a downstream pipeline, which keeps the group until that pipeline finishes; set the process mode to `oldest_first` |
| Argo CD / Flux | one controller reconciles one target | the newest commit on the target ref wins | serialize the *writes* to the release-state ref (above), not the sync |

### Build once, promote by digest

| Concern | Mechanism |
|---------|-----------|
| Address by [digest](../../GLOSSARY.md) | a container image reference `<registry>/<name>@sha256:<64 hex>`; deployment manifests carry the digest, never a tag |
| Resolve a digest | `crane digest <ref>`, `skopeo inspect --format '{{.Digest}}' docker://<ref>`, `docker buildx imagetools inspect <ref>`, `gcloud artifacts docker images describe <ref> --format='value(image_summary.digest)'`, `aws ecr describe-images --query 'imageDetails[0].imageDigest'` |
| Promote without rebuilding | re-tag or copy the verified digest: `crane tag <ref>@<digest> production`, `crane copy`, `skopeo copy`, `gcloud artifacts docker tags add`, `aws ecr put-image` with the existing manifest |
| Reject a tag where a digest belongs | the code that renders deployment manifests refuses an image reference without `@sha256:`; a check over rendered manifests does the same |
| Web-app bundles | upload the verified bundle's bytes (a build artifact keyed by commit) to each environment's static host; do not run the build again at promotion |

**Runtime configuration.** A build tool that inlines environment values at
compile time (Vite's `import.meta.env`, webpack's `DefinePlugin`, Next.js's
`NEXT_PUBLIC_*`) makes every environment's bundle different. Move those values
to deploy time:

| Artifact | Per-environment settings supplied at deploy time |
|----------|--------------------------------------------------|
| Single-page web app | a small `env.js` per environment, loaded by `<script src="/env.js">` before the bundle, setting `window.__ENV__`; served uncached (`Cache-Control: no-store`, and a matching edge-cache rule on a content delivery network) while the content-hashed bundle files stay long-cached; a separate script file keeps a content security policy free of `unsafe-inline` |
| Container | environment variables, a Kubernetes `ConfigMap` / `Secret`, or a mounted config file; the image stays the same |
| Serverless function | the platform's environment configuration per stage |

Keep the build's own identity (its commit) compiled in: it says which code is
running, and error trackers group releases by it.

### GitOps and the release-state ref

| Tool | Reads | Production gate |
|------|-------|-----------------|
| Argo CD | an `Application`'s `spec.source.repoURL` + `targetRevision` (the release-state ref) + `path` | no `syncPolicy.automated` on production: an operator runs `argocd app sync <app>`; `argocd app wait <app> --sync --health` waits for it |
| Flux | a `GitRepository` (`spec.ref.branch`: the release-state ref) and a `Kustomization` or `HelmRelease` over it | the gated promotion is the only writer of the release-state ref, so publishing to it is the gate and the `Kustomization` may reconcile it automatically; or keep it `spec.suspend: true` and have the promotion run `flux resume kustomization <name>` (which applies and waits), then `flux suspend kustomization <name>` again. A `flux reconcile` alone is not a gate: an unsuspended `Kustomization` applies new revisions on its own, and a suspended one applies nothing until resumed |

**Rendered manifests on their own ref.** CI renders the environment's
manifests (Helm, Kustomize, cdk8s or another generator, to plain YAML with
image digests filled in) and commits them to a dedicated ref (for example a
`release-state` branch with no shared history with the source) that the
controller reads. The source line's release pointer then only ever
fast-forwards to the gated commit, once the identity check has passed.
`git merge --ff-only` of an older commit succeeds as a no-op, so refuse a
stale promotion before it changes anything with
`git merge-base --is-ancestor origin/<release-branch> "$GATED_SHA"`. Run it
once the promotion holds the lock, just before its first change, against a
freshly fetched pointer: an earlier promotion may have advanced the pointer
while this one waited. Confirm the result when advancing:
`git merge --ff-only "$GATED_SHA" && test "$(git rev-parse HEAD)" = "$GATED_SHA" && git push origin HEAD:<release-branch>`.

**One writer, and protection that admits it.**

| Forge | Writer identity | Protection on a machine-written ref |
|-------|-----------------|-------------------------------------|
| GitHub | a GitHub App installed on the one repository, its token minted inside the writing job only (`actions/create-github-app-token`) | classic protection: "Restrict who can push" listing that App, **no** "Require a pull request before merging" (with zero approvals it still blocks a direct push); rulesets: "Restrict updates" with the App on the bypass list, no pull-request rule; force pushes and deletion blocked |
| GitLab | a project access token or bot user | protected branch: "Allowed to push and merge" = that identity, "Allowed to merge" = no one |

A test over the workflow files can hold the identity's scope: the writer's
credential names appear in the writing job and in no other job or
workflow-level block.

### Post-deploy identity

The conditions, in this order, each under a deadline:

| Step | Kubernetes | Other platforms |
|------|------------|-----------------|
| 1. The live spec reports the promoted identity | poll `kubectl get deploy/<name> -o jsonpath='{.spec.template.spec.containers[0].image}'` until it equals `<image>@sha256:<digest>` and `.status.observedGeneration` ≥ `.metadata.generation`, failing once a deadline passes (for example 10 minutes); only then is step 2 about the new version | the platform's release or version endpoint reports the digest or commit (a static host's build-info file, a serverless function's version), polled under the same deadline |
| 2. Rollouts are ready | `kubectl rollout status deploy/<name> --timeout=10m`, then every running pod's `.status.containerStatuses[*].imageID` carries the digest; `argocd app wait --health` adds the controller's view | the platform's deployment status reaches its final ready state |
| 3. A readiness check of the critical dependencies passes | `curl -fsS --connect-timeout 5 --max-time 10 --retry 8 --retry-max-time 120 https://<host>/ready`, where `/ready` exercises what the application cannot serve without: for an application with a database, a query against it (a liveness check that answers without it does not count). `--retry` alone bounds attempts, not time: a server that accepts the connection and stalls holds the promotion until `--max-time` ends the attempt | the same endpoint; a static site's check fetches the deployed entry page and its runtime configuration file |

A permissions error reading the live state is a failure of the check, not a
reason to keep waiting: report it at once rather than letting it time out as
"not synced yet".

**A manifest of what deployed.** The deploy run uploads a small file (for
GitHub, `actions/upload-artifact` of a `deploy-manifest.json`) listing each
part it could deploy, whether it did this run, its identity and its rollout
result. A downstream workflow (`on: workflow_run`) downloads it with
`actions/download-artifact` with `run-id: ${{ github.event.workflow_run.id }}`
and `github-token` (another run's artifacts need a token, and the job needs
`permissions: actions: read`),
checks the triggering run's branch and event, and acts only on the parts that
deployed, validating any commit it reads before checking it out.
