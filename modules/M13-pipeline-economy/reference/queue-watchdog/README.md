# Queue-stall watchdog

Part of [M13 Pipeline economy](../../README.md).

A CI job's timeout (GitHub Actions `timeout-minutes`, and its equivalents
elsewhere) starts when a runner picks the job up. Time spent waiting for a
runner does not count. So a job can sit queued for hours, because no runner
is online or a self-hosted pool has no runner with the labels the job asks
for, and nothing fails. When the job belongs to a serialized workflow (one
whose concurrency group lets a single run through at a time), it also holds
the slot, and every newer run waits behind it. Without a watchdog, the first
sign is someone asking why nothing has deployed since the morning.

`find-queue-stalls.ts` reads a list of CI jobs and fails when any of them has
waited for a runner longer than a bound. It only detects; it changes nothing.

## Usage

```bash
bun find-queue-stalls.ts [--max-wait-minutes 45] [--now <timestamp>] [jobs.json | -]
```

- `--max-wait-minutes` — the bound, a non-negative integer; default 45.
- `--now` — the time to measure against, written like `2026-01-01T12:00:00Z`;
  default the current time. Tests and replays of a past incident pass a fixed
  value.
- The input is read from the file named, or from standard input when no file
  or `-` is given.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`, the
exit-code boundary, and `record.ts`, a plain-object guard that comes from the
plugin's own scripts), and those reach further into the repository. So run it
from a pinned Jig checkout; copying the script, or the script with `lib/`,
into another repository leaves imports that do not resolve. A workflow's
own token reads only its repository, so while Jig is private that checkout
needs a read-only credential of its own; the workflow template shows where it
goes.

## Input shapes

Any of:

- an array of jobs;
- `{ "jobs": [...] }`, one page of GitHub's "list jobs for a workflow run"
  response;
- an array of such pages, as `jq -s` collects them.

Each job has `id`, `name`, `status`, `created_at` (a timestamp with a time
zone, as GitHub writes it: `2026-01-01T12:00:00Z`) and optionally `html_url`
and `run_id`. An `id` or `run_id` is an integer or a non-empty string. A job that appears twice (its run was listed under two
statuses while it moved) counts once, as the copy furthest along its life:
waiting, requested or pending, then queued, then in progress, then
completed. A job never moves back, so that copy is the newest whatever order
the copies arrive in.

## The rule, and why `waiting` is left out

A job is stalled when its `status` is `queued` and it was created strictly
more than the bound ago; a job queued exactly as long as the bound passes.

Only `queued` means "waiting for a runner". GitHub marks a job `waiting` while
it waits for an environment's required reviewers to approve it: a person's
wait, which no runner can end, so it does not count. `requested`,
`pending`, `in_progress` and `completed` jobs do not count either. Any other
status is one this check does not know, and fails it (exit 2).

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | No queued job is over the bound | `OK — <n> queued job(s), none waiting over <bound> min` |
| 1 | At least one job is stalled | a line starting `STALLED`, then one line per job: name, id, run, minutes queued, bound, link |
| 2 | Usage or input error | a message on standard error |

The script fails closed: input that is not JSON or not one of the shapes
above, a job without a known `status`, an `id` or `run_id` of another type,
a queued job (any copy of it) whose `created_at` is missing, does not parse
or names a time that does not exist (30 February, 24:00), two copies of one job with
different `created_at`, or a bad option exits 2. Input it could not read
never passes.

## Feeding it from GitHub

With the [`gh` CLI](https://cli.github.com/), collect the jobs of every queued,
in-progress and waiting run (a run that has started, or waits for an
environment's approval, can still have jobs waiting for a runner) and pipe
them in. GitHub returns at most 1,000 runs for a search by status, so a
status with more runs than that fails the collection rather than leaving
the oldest runs out unseen:

```bash
set -euo pipefail
REPO="<owner>/<repo>"
for STATUS in queued in_progress waiting; do
  export STATUS
  gh api --paginate "repos/$REPO/actions/runs?status=$STATUS&per_page=100" \
    --jq 'if .total_count > 1000 then error("over 1000 runs are \(env.STATUS): the listing would leave some out") else .workflow_runs[].id end'
done | sort -u | while read -r RUN; do
  gh api --paginate "repos/$REPO/actions/runs/$RUN/jobs?filter=latest&per_page=100"
done | jq -s '.' > jobs.json
bun find-queue-stalls.ts --max-wait-minutes 45 jobs.json
```

[`templates/queue-watchdog.yml`](../../templates/queue-watchdog.yml) runs the
same collection on a schedule.

## What it leaves to the team

The script detects; what happens next is the team's choice. A team may have
its watchdog cancel a stalled run of a serialized workflow, which frees the
slot. That is safe when each run re-checks everything since the last success:
a cancelled run never advances anything, and its successor checks the whole
range again. Whether to cancel, page someone, or only report is a decision
for each repository. Post-merge verification is the case where the answer is
settled: [M10's watchdog](../../../M10-environments-deploy/reference/verified-pointer/)
cancels the stalled run and fails, because the verification queue keeps one
pending run per branch and every run covers the whole unverified range.

Jobs bound for a self-hosted runner pool with no matching runner stall the
same way, and this check catches them too.

Run the watchdog somewhere the stall cannot reach. A watchdog job scheduled
onto the pool that has stalled waits in the same queue and reports nothing,
so give it another pool (the provider's hosted runners when the stalled
pool is self-hosted), or run the collection above from outside the
provider.
