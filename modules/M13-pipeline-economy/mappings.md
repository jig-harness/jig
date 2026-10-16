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
| Which definition a run executes | A `workflow_dispatch` run executes the workflow file of the ref it is dispatched from (`--ref` on the command line, the branch picker in the web), so a run that operates on another ref takes it as an input; a `workflow_run` run executes the default branch's file with `github.ref` set to the default branch, and the triggering run's identity is in `github.event.workflow_run` | A manual pipeline runs the `.gitlab-ci.yml` of the ref it is started on; a downstream pipeline started by a trigger job or the API runs the configuration of the ref it is started for |
| The placement checked | A lint over `.github/workflows/` rejecting a per-change trigger on a workflow marked as a scheduled suite: [`reference/workflow-conventions/`](reference/workflow-conventions/README.md#heavy-per-change) | A lint over `.gitlab-ci.yml` rejecting a merge-request rule on such a job |

## Hold

GitLab CI has no known equivalent: a label change creates no merge-request
pipeline, so applying or removing a label starts no run, and a job whose
`rules:` skip it on `CI_MERGE_REQUEST_LABELS` is not created and not
counted, so nothing fails for it. Until a shape is validated there, run
full CI on every push. The rows below are GitHub Actions only.

| Rule | GitHub Actions |
|------|----------------|
| The pipeline runs on both label transitions | `on.pull_request.types: [opened, synchronize, reopened, labeled, unlabeled]` on every workflow that honours the label or reports a required check. Applying the label fires only `labeled` and removing it only `unlabeled`; listing any type replaces the three defaults, so they stay listed. The same for a `pull_request_target` trigger |
| Only the hold's own label skips work | On each heavy job, `!contains(github.event.pull_request.labels.*.name, '<label>')` as an `&&`-joined term of its `if:`. It reads the pull request's label set at the time of the run, never `github.event.action` or `github.event.label.name`, so an unrelated label event on an unheld pull request runs real CI, and the same guard serves `synchronize`, `labeled` and `unlabeled` runs alike |
| A required check fails while held | A `run:` step with `if: contains(github.event.pull_request.labels.*.name, '<label>')` that exits 1, with no `continue-on-error`, in the required job (on `!cancelled()`) or in a job it needs directly; its message names the label. The required job is never guarded: a skipped required job passes |
| Release reruns every required check | Removing the label (`gh pr edit <PR> --remove-label '<label>'`) fires `unlabeled` on every workflow listing it, and the guard reads the label as absent. Never `gh run rerun` the held run: a rerun replays the event payload that carried the label and fails on the held-head check again |
| Only results after the release count | The `unlabeled` timeline event's time, compared with each check run's `started_at`; a run started in the same second is rerun. drive-pr's `ci-hold.ts final-ready` does this |
| Merge queues | A `merge_group` run carries no pull-request labels, so the hold neither skips nor fails there; an open question of the module |
| The shape checked | The lint's `ci-hold-events`, `ci-hold-guard` and `ci-hold-sentinel` rules ([`reference/workflow-conventions/`](reference/workflow-conventions/README.md#ci-hold)), each accepting the one form above |

## Cache

The cache rules ([piece 8](README.md#8-cache)) live mostly in the task
runner or build tool, whichever computes the key; the CI provider adds the
dependency cache, the credentials and the trust boundary. A `pnpm` triple
for the [cache-mount check](reference/cache-mount-coverage/README.md) is
its default; the other package managers' are in the last row.

### By task runner and build tool

| Tool | Complete keys | One namespace, measured | Bounded, trusted |
|------|---------------|-------------------------|------------------|
| Turborepo | `globalEnv` and each task's `env` name the variables whose values enter every hash; a task with no `inputs` hashes every tracked file of its package, so no list can leave a read file out; `globalDependencies` adds files outside packages; with the strict environment mode (the default), a variable the task reads is declared or neither the task nor the hash sees it. `--force` is the bypass to avoid as a standing fix | Remote cache: the same token (`TURBO_TOKEN`), team (`TURBO_TEAM`, sent with every remote-cache call to select whose cache is read and written) and signature key in every job's environment; none of them enters a task's hash, and a job whose token is empty runs on its local cache alone without failing, so every task the shared cache would have served is a miss; `--summarize` writes `.turbo/runs/<run>.json`, whose `tasks[].cache.status` (`HIT` or `MISS`) gives the run's hit rate; the worktrees of one clone share the main worktree's `.turbo/cache` by themselves, and an explicit `cacheDir` switches that off | The local cache is unbounded by default: `cacheMaxAge` and `cacheMaxSize` in `turbo.json` (or `TURBO_CACHE_MAX_AGE`, `TURBO_CACHE_MAX_SIZE`) turn on eviction at the start of each `turbo run`, oldest first; on a version without them, a scheduled prune over `.turbo/cache` by modification time (`find … -mtime +<days> -delete`), with the window recorded. `remoteCache.signature: true` with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` signs artifacts, and one that does not verify is rerun |
| Nx | `namedInputs` with file sets, `env` inputs (the variable's value) and `runtime` inputs (a command's output, such as the toolchain version); a `production` set that leaves test files out of a build's key. `--skip-nx-cache` is the bypass to avoid | The remote cache's access token in every job; a run's output marks each task read from the local or remote cache, and the final line counts them; `nx reset` empties the local cache | `cacheDirectory` (or `NX_CACHE_DIRECTORY`) is pruned on a schedule; the remote cache's read-only tokens for untrusted runs, read-write only on trusted ones |
| Bazel | An action's key hashes its inputs and command line; `--action_env=NAME` passes a variable and puts its value into the key, and an undeclared one reaches no action | `--remote_cache=` with the same `--remote_header=` credentials in every job; the build's final `INFO: <n> processes:` line counts `remote cache hit` | `--disk_cache=` grows without bound: a scheduled prune of the directory, or the garbage-collection size flag where the version has one; `--remote_upload_local_results=false` on untrusted runs, so they read but never write |
| Gradle | A task's key hashes the inputs it declares (`@Input`, `@InputFiles`); a variable read with `System.getenv` inside the action is invisible to the key, so it is declared as an input. `--rerun-tasks` is the bypass to avoid | `org.gradle.caching=true` everywhere that shares; a remote build cache's credentials in every job; the console marks each task `FROM-CACHE`, and a build scan tallies them | The local build cache removes entries unused for 7 days (`removeUnusedEntriesAfterDays`); the remote cache has `push = true` only on the trusted branch's jobs, and `pull` elsewhere |
| BuildKit (container builds) | A layer's key hashes the instruction and the files it copies; `RUN --mount=type=cache,target=<path>` keeps a directory across builds for that `RUN` alone, and the store is pointed at it by a stage-level `ENV` the later processes inherit | `--cache-to`/`--cache-from` with `type=registry` or the provider's cache exporter, `mode=max`; the default `docker` driver exports no cache but the inline one unless the containerd image store is enabled, so on the classic image store `type=gha` is declared and inert (the provider's cache usage stays at zero bytes) and the `docker-container` driver, or the containerd image store, is needed; `--progress=plain` logs `CACHED` per step | `docker builder prune --filter until=<duration>` bounds the builder's cache; every step that reads the store mounts it, which [`reference/cache-mount-coverage/`](reference/cache-mount-coverage/README.md) checks |
| Package managers (the triple for the cache-mount check) | `pnpm`: `npm_config_store_dir` pins the store, `--store-dir` is the flag to avoid. `npm`: `npm_config_cache`, `--cache`. Yarn: `YARN_CACHE_FOLDER`, `--cache-folder`. `pip`: `PIP_CACHE_DIR`, `--cache-dir`. `uv`: `UV_CACHE_DIR`, `--cache-dir`. `cargo`: `CARGO_HOME` (no flag). `go`: `GOMODCACHE` (no flag) | A per-command flag binds one process; the variable is inherited by every child, which is why the check fails the flag | — |

### By CI provider

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| Complete keys | `actions/cache` (and the `cache:` input of the setup actions) keyed by `hashFiles()` over every lockfile with `runner.os` and the toolchain version; `restore-keys` only as prefixes of the same scheme, since a fallback hit is a partial restore the task then completes | `cache:key:files` (up to two files, hashed) with `cache:key:prefix`, and `cache:paths` for what is kept |
| One namespace | The same `env:` on every job of a cache group ([the lint's `cache-env-parity` rule](reference/workflow-conventions/README.md#cache-env-parity)); a first step that fails on an empty credential (`[ -n "$TOKEN" ]`), because an absent or rotated-out secret reads as an empty string; the `secrets` context is unavailable in `if:`, so a composite action takes each value as an input | The same `variables:` on every job of the group; a `before_script` that fails on an empty variable. Caches of protected branches are kept apart from unprotected ones by the provider, so a job on an unprotected branch never shares a protected branch's cache |
| Bounded | The repository's caches are capped (10 gigabytes) and an entry unused for 7 days is evicted, the oldest first beyond the cap; `gh cache list` and `gh cache delete`; a persistent runner volume keeps exact keys only, with no fallback, and evicts after days idle, so its key convention (`<workflow>-<purpose>`) is written down; a self-hosted runner's volume is pruned by the team's own schedule | The runner's local cache directory, or the lifecycle rule of the object store behind a distributed cache; "Clear runner caches" resets |
| Measured | The restore step's `cache-hit` output, and the task runner's summary, written to `$GITHUB_STEP_SUMMARY`; a declared cache that stores nothing shows in `gh api repos/<owner>/<repo>/actions/cache/usage` as zero bytes | The job log's cache lines (extracted, or not found) and the project's cache listing |
| Trust boundary | A `pull_request` run from a fork gets no secrets, so no remote-cache credentials: it runs uncached, and never under `pull_request_target` to get them; a cache written on a pull-request branch is readable from that branch alone, and the default branch's caches are readable by every pull request, which is the provider's own line; the task runner's remote cache is signed | `cache:policy: pull` on jobs of merge requests from forks; protected-branch caches as above |

## Size

The runner classes are vendor-bound: each provider and each runner vendor
names its own, and the README names none. The rule maps onto them like
this.

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| The class follows the work | `runs-on:` names the class: a hosted label (`ubuntu-slim` is the smallest hosted Linux class: one processor in an unprivileged container, with a minimal tool set, no Docker and a 15-minute job limit, so it suits the jobs that only decide or report; `ubuntu-latest` is the smallest full virtual machine; larger hosted runners carry labels the organization defines), a runner vendor's label (the vendor's label usually carries the core count), or a self-hosted pool's labels; a matrix may set `runs-on` per leg, and an expression may pick the class from the resolver's outputs | `tags:` select a runner: the hosted sizes are tags (`saas-linux-small-amd64` is the smallest; `medium`, `large` and up follow), and a self-hosted runner's tags are the pool's |
| The smallest class for the jobs that only decide or report | the resolver, the aggregator and an echo job on the smallest label the pool offers, whatever the other jobs use | the same, by tag |
| The measurement behind a class | the jobs API's `started_at` and `completed_at` per job, and the billing usage report's minutes per runner type; `gh run view <run> --json jobs` for one run | the jobs API's `duration`, and the Usage Quotas page per runner size |

### Parallelism, by task runner and test runner

The product of the two columns on one machine is at most its cores. The
core count is per machine (`nproc`, `os.availableParallelism()`), never per
package.

| Tool | Package concurrency | Workers per package |
|------|---------------------|---------------------|
| Turborepo | `--concurrency` on `turbo run` (default 10) | — |
| Nx | `--parallel=<n>` (default 3) | — |
| pnpm `-r` / Lerna | `--workspace-concurrency` / `--concurrency` | — |
| Vitest | — | top-level `maxWorkers` (default: the machine's available parallelism), set in the configuration of every package whose test script invokes it |
| Jest | — | `maxWorkers` or `--maxWorkers` (default: the cores less one) |
| pytest-xdist | — | `-n <n>` (`auto` is the cores) |
| Go | `go test -p <n>`: test binaries (packages) run at once (default: `GOMAXPROCS`, normally the cores) | `-parallel <n>`: `t.Parallel` tests at once within one binary (default: `GOMAXPROCS`) |
| Gradle | `org.gradle.workers.max` | `maxParallelForks` on each test task |
| Bazel | `--jobs` | `--local_cpu_resources` |

## Legs

| Rule | GitHub Actions | GitLab CI |
|------|----------------|-----------|
| CI is the authority | the required check on the merged head (M1's aggregator) | the pipeline's verdict on the merge request |
| A leg before CI selects as CI does | the pre-push hook ([M1's hook managers](../M1-gates-enforcement-ladder/mappings.md#hook-managers)) runs the resolver over the change-area catalog, or the task runner's changed-since filter the CI job runs (`turbo run test --filter='...[origin/<base>]'`, `nx affected --base=origin/<base>`), not the unscoped root script | the same; the merge request pipeline's `changes:` rules give the base |
| A remote sandbox has no history | a changed-since filter cannot resolve on a machine without the repository's git history, so the dispatching leg resolves the package list first and sends it; a dispatched sandbox job receives no secret of the CI job (so secret-dependent checks never need one) and cannot run the workflow files themselves | the same |
| A costly extra leg | a `workflow_dispatch` run on a CI-like machine, opt-in through the change-area catalog per area, with its reopen conditions in the cost ledger | a manual pipeline (`when: manual`) on the same terms |

## Measuring cost

The measures of the README's piece 11, read from the provider's records
by a scheduled job into M11's registry (`ci-runner-minutes`,
`ci-sandbox-minutes-share`, `ci-cost-per-change`, `ci-queue-wait`,
`ci-cache-hit-rate`).

| Measure | GitHub Actions | GitLab CI |
|---------|----------------|-----------|
| Time per job | The jobs API's `started_at` and `completed_at`; `gh run view <run> --json jobs` | The jobs API's `duration` and `queued_duration` |
| Runner-minutes per pipeline and job | the jobs API's `completed_at` less `started_at`, summed per job and per workflow over the window; `gh run list --json` gives the runs of a workflow | the jobs API's `duration` summed per job and per pipeline |
| Billed minutes | The account's billing usage report (per workflow and runner type) | Compute minutes on the group's or project's Usage Quotas page |
| Cost per change | the runner-minutes of every run on a pull request's heads, and of its post-merge run, over the merged pull requests of the window; the billing report's rate per runner type turns minutes into money | the same over merged merge requests |
| Queue wait | the jobs API's `started_at` less `created_at` per job; the watchdog bounds the worst case, the trend sizes the pool | the jobs API's `queued_duration` |
| Cache hit rate | the line each run writes to its summary ([cache](#cache)) | the same |
| The ledger | [`templates/ci-cost-ledger.yaml`](templates/ci-cost-ledger.yaml), checked by [`reference/cost-ledger/`](reference/cost-ledger/README.md) on changes to it | the same |
