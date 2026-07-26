# M8 mappings — per-ecosystem implementations

The module [invariant](README.md) — classify, file with a durable id,
reconstruct as a pre-fix fixture, answer with an additive lens, validate before
gating, then measure — is tool-independent. This file maps its mechanisms onto
concrete [issue trackers](../../GLOSSARY.md), eval runners, telemetry, and agent
runtimes. Replace `<placeholders>` with your values.

## The gates, per rung

| Gate | When it runs | Rung |
|------|--------------|------|
| corpus-lint | on any change to the corpus / taxonomy | [CI](../../GLOSSARY.md) (authority); cheap enough to pre-commit too |
| parity report | on a schedule (a weekly parity snapshot) | CI on a cron; its failure reopens a lever + feeds [M7](../M7-pr-lifecycle-review/) promotion |
| reflection trigger | at the end of a review loop, once it converges | not a gate — a loop step whose exit code says whether to prompt (see § Reflection below) |

### GitHub Actions

```yaml
# .github/workflows/learning-loop.yml
on:
  pull_request:
    paths: ['corpus.yaml', 'miss-taxonomy.yaml']
  schedule:
    - cron: '0 9 * * 1'        # weekly parity snapshot
jobs:
  corpus:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: reference/corpus-lint/test-check-corpus.sh
      - run: CORPUS=corpus.yaml reference/corpus-lint/check-corpus.sh
  parity:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: ./scripts/parity-snapshot > parity.tsv      # from your telemetry
      - run: MIN_PRECISION=0.90 reference/parity-report/check-parity.sh parity.tsv
```

### GitLab CI

```yaml
corpus-lint:
  rules: [{ changes: ['corpus.yaml', 'miss-taxonomy.yaml'] }]
  script:
    - reference/corpus-lint/test-check-corpus.sh
    - CORPUS=corpus.yaml reference/corpus-lint/check-corpus.sh
parity:
  rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]
  script:
    - ./scripts/parity-snapshot > parity.tsv
    - MIN_PRECISION=0.90 reference/parity-report/check-parity.sh parity.tsv
```

## Issue trackers (durable lever ids)

The lever id (`L-NNNN`) is the spine — a lens, a fixture, and a metric all point
at it. It needs a home that outlives a PR.

| Tracker | Wiring |
|---------|--------|
| Linear / Jira | one issue per lever with a stable key; a `learning-loop` label; the corpus `lever:` is the issue key. Uniqueness is free (the tracker assigns keys) |
| GitHub issues | one issue per lever; the issue number is the `L-NNNN`; a `lever` label. Guard next-number races the same way as [ADR numbering](../M5-adr-practice/) |
| Flat file | a `levers.md` ledger if you have no tracker; corpus-lint enforces uniqueness within the corpus regardless |

## Eval runners (replaying the corpus)

The corpus is data; *running* a fixture — replay the pinned commit through the
reviewer and diff its findings against the expected — is a job in your own
stack, not shipped here (see [README](README.md) § Not ported).

| Runtime | Replay shape |
|---------|--------------|
| Claude Code / Codex / Cursor | a skill/command that checks out `pinned_commit`, runs the reviewer with the current lens set, and asserts the expected finding appears |
| A test harness | each `required: true` fixture becomes a case in your normal test runner; the corpus is the case list |

Only a fixture whose live replay passes flips to `required: true` — corpus-lint
enforces that a `required` fixture carries the validation record, but the
*running* is the runner's job.

## Telemetry (the measure step)

The parity report consumes tallies; producing them is a telemetry job.

| Tool | Role |
|------|------|
| PostHog / analytics | per-review events (was a finding real? was it acted on?) aggregate into the `<reviewer> tp fp missed` rows |
| Weekly snapshot | a scheduled query emits `parity.tsv`; the parity gate turns it into keep/promote/kill + `missed_blockers` |

Wire the actual metric events under [M11](../M11-process-observability/) (process
observability) — M8 only defines what the numbers *mean* for the loop.

## Reflection & memory-promotion commands

The two companion cycles are runtime commands with a human-approval checkpoint.

| Runtime | Reflection | Memory promotion |
|---------|-----------|------------------|
| Claude Code | a `/reflect` command appends to a feedback inbox; a `/review-reflection-feedback` command proposes scaffolding changes for human approval | a `/promote-memory` command lifts private memory into git-tracked shared memory |
| Codex / Cursor / other | an end-of-session hook writing to the inbox; a periodic review step | a scripted promote step over the agent's memory store |

### Reflection: firing it on the round count

*Whether* to reflect is the part that decays. The
[reflection trigger](reference/reflection-trigger/) reads
[M7](../M7-pr-lifecycle-review/)'s
[convergence decision](../M7-pr-lifecycle-review/reference/review-convergence/)
— which already carries the round count — and fires only at convergence, only at
or above the threshold. Its exit 3 ("nothing to do") is not a failure, so wire it
as a condition rather than a bare step:

```sh
# last step of the review loop, after check-round-converged.sh wrote decision.txt
CHANGE="$PR" INBOX=docs/reflection-inbox.md ARCHIVE=docs/reflection-archive.md \
  ROUND_THRESHOLD=3 reference/reflection-trigger/reflection-trigger.sh decision.txt \
  && trigger_rc=0 || trigger_rc=$?

case "$trigger_rc" in
  0) <your runtime's reflect command> ;;   # /reflect, an end-of-session hook, …
  3) : ;;                                  # SKIP — ordinary review, nothing to do
  *) echo "reflection trigger failed (exit $trigger_rc)" >&2; exit "$trigger_rc" ;;
esac
```

Only **3** means "nothing to do". A bare `if …; then reflect; fi` treats exit 2 —
a malformed or self-contradictory `decision.txt` — as an ordinary skip, so a
broken producer silently stops reflection from ever firing and nothing reports it.
Re-raise every status except 3.

| Runtime | Where the trigger sits |
|---------|------------------------|
| Claude Code / Codex / Cursor | inside the skill or command that drives the review loop, as its final step — the same place that decided the loop was done |
| A CI-driven loop | a step after the convergence check; on `PROMPT`, open an issue or post the record so the prompt survives the job ending |
| A session hook | pass the decision file through; a hook that fires on *every* session end is the under-firing problem again, just inverted |

`CHANGE` is the **source-change** key — a PR number, branch, or ticket key. It is
*not* a lever id, and conflating the two breaks the join rather than making it:
levers are `L-NNNN` in the [lever ledger](#issue-trackers-durable-lever-ids), one
change can produce several levers or none, and the lever does not exist yet at the
moment the trigger fires. Keep `change` as the source-change key and record the
lever separately, in the record's `disposition:` field — that field is the foreign
key from a reflection to the lever it became, and it is what lets you ask both
"which changes fought the scaffolding hardest" and "which levers came from them".

`ARCHIVE` is optional but wanted in practice: the inbox is worked down as entries
become levers, and the trigger's duplicate guard reads the archive too. Move
processed entries there rather than deleting them, or a later re-run of the same
change re-appends a record that was already handled.

**On isolated runners the lock is not the guard.** The trigger's `$INBOX.lock`
serializes processes sharing a filesystem; two CI jobs on separate runners each
have their own checkout and their own lock, so both will append and both will
prompt. What actually deduplicates across runners is that the inbox is
**git-tracked**: the second job's push loses the race, has to rebase, and on the
retry the trigger finds the marker and skips. So commit the inbox as part of the
job, and key anything the prompt *causes* — an issue, a post, a notification — on
`change`+`rounds`, because the trigger can promise one record per change and round
but not one side effect.

The **human-approval** step on reflection-proposed scaffolding changes is
[HITL](../../GLOSSARY.md) (see [M7](../M7-pr-lifecycle-review/)'s registry) — a
system editing its own rules must stop for a person, whatever the runtime.
