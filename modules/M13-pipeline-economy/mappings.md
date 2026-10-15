# M13 per-ecosystem mappings

The module's sub-invariants are tool-independent; this page maps each onto
the two CI providers Jig's other modules map, GitHub Actions and GitLab CI.
Terms of art: see [GLOSSARY.md](../../GLOSSARY.md).

The two providers differ most in one place. On GitHub Actions each workflow
and each job reports its own check, so honest signal is something a team
builds (an aggregator job). On GitLab CI the pipeline as a whole is the
verdict a merge request waits for, so the aggregator is built in, and the
risk moves to pipelines that are never created.

## Honest signal

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| No trigger-level path filter on a required pipeline | No `paths:` or `paths-ignore:` under `on.pull_request` or `on.push` in a workflow behind a required check. A workflow skipped by a path filter leaves its required checks pending, so the pull request cannot merge | No `changes:` in `workflow:rules` for merge-request pipelines; select jobs instead. Keep the project setting "Skipped pipelines are considered successful" off |
| A skipped job is judged, not trusted | A job skipped by its `if:` reports success to branch protection; require the aggregator, never the job | A job that `rules:` leave out is not created and not counted; the pipeline status covers the jobs that ran |
| One aggregated verdict | An aggregator job with `needs:` on every selected job and `if: ${{ !cancelled() }}`, comparing each `needs.<job>.result` (`success`, `failure`, `cancelled`, `skipped`) with the resolver's selection; it is the only required check | Built in: "Pipelines must succeed" in the merge-request settings judges the whole pipeline |
| Runs when not cancelled | `!cancelled()`; `always()` also runs, and fails, on a run a newer push cancelled | Not needed: an interrupted pipeline is superseded by the newer one |
| The exit code is the verdict | No `continue-on-error: true` on the aggregator or its verdict step | No `allow_failure: true` on a job whose failure must block |

## Select

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| One resolver per run | One small job runs the [change-area](../M3-change-area-catalog/README.md) resolver and publishes job `outputs:`; other jobs read `needs.<resolver>.outputs.<name>` in their `if:` | `rules:` are evaluated when the pipeline is created, before any job runs, so a resolver job cannot deselect jobs of its own pipeline. Either generate each job's `rules: changes:` from the catalog, or let the resolver job write a child pipeline and start it with `trigger: include: - artifact:` and `strategy: mirror` (`depend` before GitLab 18.2), a dynamic child pipeline whose verdict becomes the trigger job's. Without a strategy the trigger job succeeds as soon as the child pipeline is created, whatever the child's checks then report |
| Fail closed | The resolver sets the "everything" output when a changed file matches no area, or a gate fails the change until every file belongs to an area | The generated `changes:` lists include a catch-all for unmatched paths, or the resolver's child pipeline includes every job |
| Toolchain setup only for selected work | The setup step carries the same `if:` as the work it serves, or the job is skipped as a whole | The job is not created when its `rules:` do not match; a resolver job installs only the resolver's runtime |
| Consolidate satellites | Several one-command workflows become steps or jobs of one workflow behind one resolver | Several small pipelines' jobs move into the main `.gitlab-ci.yml` under the same rules |
| Unscoped backstop | A `push` to the integration branch resolves to every area (or the whole unverified range) | A branch pipeline on the default branch runs every job: `rules: - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` |
| Reproduce on a fresh base | `git fetch origin <base>` then run the failing command on `origin/<base>` before blaming the change | The same, with `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` |

## Supersede

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| Cancel a pull request's superseded runs | `concurrency: { group: <workflow>-<pull request number or ref>, cancel-in-progress: true }` | `interruptible: true` on the jobs, plus "Auto-cancel redundant pipelines" (on by default) or `workflow: auto_cancel: on_new_commit: interruptible` |
| A key per non-interchangeable run | The group names the ref or commit and `github.event_name`; a `workflow_dispatch` run is keyed by `github.run_id`, never by an interpolated input | Pipelines of different refs never cancel each other; with the default `auto_cancel: on_new_commit: conservative`, a newer pipeline on the same ref cancels an older one unless a job with `interruptible: false` has already started |
| What happens to a third run | One pending run per group survives: a newer run cancels the older pending one, also with `cancel-in-progress: false`, and nothing reports it as an error; group names compare case-insensitively | A job in a `resource_group` waits its turn; nothing is dropped. The `process_mode` (`unordered`, `oldest_first`, `newest_first`, `newest_ready_first`) picks the order |
| Serialized post-merge verification | A fixed group for the integration branch with `cancel-in-progress: false`, and the run checks the range from the verified pointer to its head | A `resource_group` on the verification job. Waiting jobs are not dropped: with `newest_first` the older ones still run afterwards, so the step that advances the verified pointer must only move it forward (or enable "Prevent outdated deployment jobs"), and each run checks the range from the verified pointer, as on GitHub |

## Bound

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| A timeout on every job | `timeout-minutes:` on each job (default 360), about two to three times the slowest healthy run and at most an hour; there is no workflow-level default, so each job needs its own, and the [lint](reference/workflow-conventions/README.md#job-timeout) checks it; a job that calls a reusable workflow cannot carry one, so the called workflow's jobs do; steps may carry their own | `timeout:` on each job, about two to three times the slowest healthy run and at most an hour; `default:` does not accept it, so share one value through `extends:` or a YAML anchor; the project's default (60 minutes unless changed) and each runner's maximum also apply |
| Queue time is not run time | `timeout-minutes` does not count time a job waits for a runner; the jobs API shows a waiting job as `status: queued` with its `created_at` | A job waiting for a runner is `pending`; the jobs API reports `queued_duration` |
| Queue-stall watchdog | A scheduled workflow feeding the jobs API to [`reference/queue-watchdog/`](reference/queue-watchdog/) ([`templates/queue-watchdog.yml`](templates/queue-watchdog.yml)) | A pipeline schedule running a job that reads `pending` jobs' `queued_duration` from the jobs API and fails over the bound |

## Order and parallelize

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| Cheapest first | Cheap steps first in the first job, before the toolchain install | An early stage of small jobs, or the cheap commands first in one job |
| Critical path in parallel | Jobs that `needs:` only the resolver run side by side | `needs:` makes jobs start as soon as their dependencies finish, regardless of stage |
| Shard long suites | A `strategy.matrix` of shard indexes, each leg with its own `timeout-minutes` | `parallel: <n>`, with `CI_NODE_INDEX` and `CI_NODE_TOTAL` telling each job its shard |
| Report every independent failure | `strategy.fail-fast: false` on matrices | Jobs of a stage all run; jobs connected only by `needs:` run unless a job they need failed |

## Place

| Placement | GitHub Actions | GitLab CI |
|-----------|----------------|-----------|
| Every pull request | `on: pull_request` | `rules: - if: $CI_PIPELINE_SOURCE == "merge_request_event"` |
| Every push to the integration branch | `on: push: branches: [<integration branch>]` | `rules: - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` |
| On a schedule | `on: schedule: - cron:`; in a public repository GitHub disables a scheduled workflow after 60 days without repository activity, so watch that it still runs | A pipeline schedule; `rules: - if: $CI_PIPELINE_SOURCE == "schedule"` |
| On demand | `on: workflow_dispatch` with `inputs:` naming the suite | A manual job (`when: manual`) or a pipeline run from the web (`$CI_PIPELINE_SOURCE == "web"`) |
| The placement checked | A lint over `.github/workflows/` rejecting a per-change trigger on a workflow marked as a scheduled suite: [`reference/workflow-conventions/`](reference/workflow-conventions/README.md#heavy-per-change) | A lint over `.gitlab-ci.yml` rejecting a merge-request rule on such a job |

## Measuring cost

| Measure | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| Time per job | The jobs API's `started_at` and `completed_at`; `gh run view <run> --json jobs` | The jobs API's `duration` and `queued_duration` |
| Billed minutes | The account's billing usage report (per workflow and runner type) | Compute minutes on the group's or project's Usage Quotas page |
