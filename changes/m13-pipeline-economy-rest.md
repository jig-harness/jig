---
release: minor
---

M13 Pipeline economy is complete: the CI hold, caches, runner sizing, one
authoritative leg and measured cost join the module, with the reference
checks and criteria that score them; the github-actions skill reviews
concurrency keys, dispatch refs and expression injection; and gate output for
agents, classified retries and a gated pipeline index reach M12, M1 and M10.

### Added

- [M13](../modules/M13-pipeline-economy/README.md) states the CI hold as
  a practice (core piece 7): a required check fails on every held head from
  the instant the label is applied, only the hold's own label transitions
  skip work, releasing the hold reruns every required check, and the driver
  certifies only results that started after the release. The
  [workflow-convention lint](../modules/M13-pipeline-economy/reference/workflow-conventions/README.md)
  gains a `ci-hold-events` rule for the trigger types beside its guard and
  held-head rules; [M1's CI skeleton](../modules/M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
  carries the wiring as an opt-in block; M7's review-round piece links the
  practice; criteria score it at Standard and Strict.
- M13 core piece 8, caches: complete keys (environment values included),
  one shared namespace where an empty credential fails the job, bounded
  retention with a hit rate reported each run, and a trust boundary where
  only trusted contexts write. The new
  [cache-mount-coverage](../modules/M13-pipeline-economy/reference/cache-mount-coverage/README.md)
  check fails a container build whose dependency store is on a cache mount
  that a reading step does not carry or carries as a different cache, or
  that is pinned by a per-command flag, and stops on any shell spelling it
  does not read; the mappings cover the task runners, build tools and both CI
  providers; M11's registry template gains `ci-cache-hit-rate`; criteria
  score the piece's key, namespace, hit rate, retention, wiring and trust
  boundary.
- M13 core pieces 9 to 11: a job's runner class follows its measured work
  and a machine's parallelism is one bounded product; CI is the single
  authority for each check and every leg before it selects no more than CI
  does, with a costly extra leg an opt-in under reopen conditions; and cost
  is measured on a cadence, each decision recorded before and after with
  the threshold that reopens it. The
  [cost ledger template](../modules/M13-pipeline-economy/templates/ci-cost-ledger.yaml)
  and the [cost-ledger check](../modules/M13-pipeline-economy/reference/cost-ledger/README.md)
  carry it; M11's registry gains `ci-runner-minutes`,
  `ci-sandbox-minutes-share`, `ci-cost-per-change` and `ci-queue-wait`;
  criteria score the runner class, the one authority
  and the ledger.
- The [github-actions](../plugin/skills/github-actions/SKILL.md) skill
  checks concurrency keys (the ref, the event and the dispatch inputs; one
  pending run per group survives; group names compare case-insensitively),
  which workflow file a dispatch or a `workflow_run` executes, queue time
  outside `timeout-minutes`, a workflow expression inside `run:` in favour
  of `env:`, the identity that writes a machine-advanced ref, and coverage
  as a scheduled trend; the glossary defines expression injection.
- [M12](../modules/M12-parallel-agent-ergonomics/README.md) core piece 8,
  agent-facing gate output: a quiet mode condenses a green run and prints a
  red one in full, keeps the gate's own exit status, and ends each part
  with one named verdict line, where a missing line means did not run. The
  [quiet-run](../modules/M12-parallel-agent-ergonomics/reference/quiet-run/README.md)
  wrapper carries it, spooling the output to temporary files and passing a
  cancellation on to the command; the mappings give the runners' flags and the
  command-rewriting hook's safety model; criteria score the named quiet
  invocation (Lite), the scripted quiet form and the verdict line, and apply
  to single-checkout repositories too, since only the module's worktree
  practices are expected-absent there. Jig's own `scripts/gates.ts` does not yet run in the
  quiet form (M12's Future).
- [M1](../modules/M1-gates-enforcement-ladder/README.md) gate-authoring
  rule "classify before retrying": a step retries only an error its pattern
  list marks transient, aborts at once on any other with the original
  message, and the classifier is tested against recorded messages. The
  [retry-classified](../modules/M1-gates-enforcement-ladder/reference/retry-classified/README.md)
  wrapper runs a command under that rule, with an optional permanent list
  that wins over a transient-looking line and a doubling delay, and answers
  for one message in its classify mode; the mappings place it per provider; a Strict criterion
  scores it.
- [M10's architecture template](../modules/M10-environments-deploy/templates/CI-ARCHITECTURE.md)
  states that a page listing the pipelines is dropped, checked or generated
  by M2's ladder, never hand-kept; a Standard criterion scores it.
- Glossary entries for the CI hold's held head, cache namespace, expression
  injection, quiet mode, verdict line, error classifier and pipeline index.

### Changed

- [drive-pr](../plugin/skills/drive-pr/README.md)'s CI-hold contract now
  requires the workflow to run on the hold label's own `labeled` event and
  to skip on no other label event.
- M13's placement piece and mappings carry the run-definition rule for a
  dispatch and a `workflow_run` on both providers.
- `plugin/CONFIGURATION.md`: `ci.hold_label` points at the M13 practice.
