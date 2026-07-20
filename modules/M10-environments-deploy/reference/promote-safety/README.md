# Promote-safety lint

A gate for the one wiring rule a production-deploy workflow has to keep:
**deploy only the verified artifact, and only on a human's say-so.** It scans a
workflows directory and fails a production deploy that either fires itself or
ships something other than the `verified` pointer.

## Why it exists

The delivery architecture (see [`../../templates/CI-ARCHITECTURE.md`](../../templates/CI-ARCHITECTURE.md))
ends in a **manual, gated promotion** of the **verified** artifact to
production. Two workflow mistakes break that promise quietly:

- **(a) it auto-fires.** A production deploy triggered on a branch push with no
  manual gate means every merge ships to users — a bad merge reaches production
  before anyone looks. Promotion is supposed to be a deliberate human act.
- **(b) it ships a mutable ref.** A production deploy that checks out a moving
  branch (`main`), `HEAD`, or an `:latest` image tag ships *whatever the branch
  happens to be*, not the commit that actually passed verification — so "we only
  deploy verified artifacts" silently stops being true.

This lint makes both regressions loud.

## Mechanism

**Scope to the production-deploy job.** A workflow has many jobs; the checks
apply to the job that *clearly* deploys to production — one whose lines carry
**both** a deploy signal (the word `deploy`) **and** a production signal
(`prod` / `production`). The lint segments the workflow into jobs (GitHub
Actions `jobs:` children; GitLab top-level jobs) and evaluates each
production-deploy job on its own, so a gate or a `verified` reference on some
*other* job — a preview deploy with its own `environment:`, a build job that
checks out the verified ref — can't mask an unsafe production job. Build, test,
and preview jobs lack the deploy+prod pair and are ignored. Detection runs
against a **comment-stripped** view, so a `#` comment mentioning (say)
`workflow_dispatch` can't fake a gate that isn't wired.

A production-deploy **job** is flagged when **either** holds:

| # | Trips when | Safe alternative |
|---|-----------|------------------|
| (a) | it fires on `push` — a GitHub `on: push` (bare/quoted scalar, flow sequence, `- push` block sequence, block, or inline mapping), or a GitLab push rule (`$CI_PIPELINE_SOURCE == "push"` / legacy `only: pushes`, **including a job-level rule**) — **and** that job has no gate: no **job-level** `environment:` key, no GitLab `when: manual` | gate the deploy job behind a protected job-level `environment:`, GitLab `when: manual`, or trigger **only** via `workflow_dispatch` (no `push`) |
| (b) | the job selects a mutable ref **at all** — a `ref:` or a `--ref` flag of `main`/`master`/`develop`/`HEAD`, a `github.ref`/`github.ref_name`, or an `@latest`/`:latest` tag | deploy **only** the `verified` pointer/artifact and do not select a mutable ref in the deploy job (`ref: refs/tags/verified` / `--ref refs/tags/verified`, or download the `verified-*` artifact) |

A safe production deploy gates the push behind a protected environment (or
triggers only manually) and ships only the verified pointer, so it trips
neither. Two subtleties the heuristic gets right:

- **`workflow_dispatch` is not a gate on a push run.** It is an *additional*
  manual trigger — `on: [push, workflow_dispatch]` still auto-deploys on every
  push. So (a) only clears on a real gate: an `environment:` key (where
  GitHub/GitLab **environment protection rules** — required reviewers, wait
  timers — are attached; the actual approval is a repo setting the lint can't
  see, so it checks the wiring hook exists and leaves the rule to the
  [maturity criterion](../../maturity.yaml)) or a GitLab `when: manual`.
- **A `verified` reference does not clear a mutable ref.** A line matcher cannot
  prove *which* line is the deploy command, so a `verified` reference elsewhere
  in the deploy job — a build-artifact download, a tooling checkout — cannot
  establish that the deploy itself ships verified. A job that checks out `main`,
  downloads a verified artifact, then runs `./deploy --ref main` is unsafe. The
  rule is therefore simple and sound: **a mutable ref anywhere in the
  production-deploy job is unsafe.** The safe shape carries no mutable ref at all
  — it deploys `ref: refs/tags/verified` or a downloaded `verified-*` artifact
  and never checks out a moving branch.

## Mirror it on both rungs

The workflows are the thing being checked, so run it as a required check on every
PR that touches the deploy workflows, exactly as
[M7](../../../M7-pr-lifecycle-review/)'s reviewer-wiring lint does. A pre-commit
run is a nice-to-have; [CI](../../../../GLOSSARY.md) is the authority (see
[M1](../../../M1-gates-enforcement-ladder/)).

```sh
WORKFLOWS_DIR=.github/workflows ./check-promote-safety.sh
```

## Files

| File | Role |
|------|------|
| `check-promote-safety.sh` | the gate; `WORKFLOWS_DIR` or file args select inputs |
| `test-check-promote-safety.sh` | paired self-test |
| `fixtures/safe/` | manual+verified, env-gated push+verified, non-prod preview, push+dispatch **with** environment, env on the deploy job (other job bare), mutable ref on a non-deploy job, GitLab push rule **with** a gate — must pass |
| `fixtures/unsafe/` | auto-push prod (a), push+dispatch with no env (a), env on a *different* job (a), GitLab job-level push rule ungated (a), flow-style `on: { push }` (a), quoted `on: "push"` (a), block-sequence `on: - push` (a), step-input environment not a gate (a), mutable branch ref (b), `--ref main` flag (b), `:latest` image (b), `verified` only in a step name (b), `verified` on a *different* job (b), mutable ref + in-job verified download (b) — must fail |

Run the self-test with `./test-check-promote-safety.sh`.

## Known limits

Bash + awk job segmentation, not a full YAML evaluator. The checks are scoped to
the production-deploy job, but three residual imprecisions remain, all left to a
precise-parse version in whatever language the repo already uses (same reasoning
as [M7](../../../M7-pr-lifecycle-review/)'s lint):

- A "production-deploy job" is identified heuristically (a job carrying both a
  `deploy` and a `prod`/`production` signal). A job that merely mentions both in
  passing (a `notify` step logging "deploy to production done") could be
  mis-scoped — toward flagging, the safe direction.
- It reads a **job-level** `environment:` key (at the job-body indent, not a
  deeper step *input* named `environment`) as "a gate exists" — but it does not
  confirm the environment actually has required reviewers configured (that lives
  in repo settings, which the strict [maturity criterion](../../maturity.yaml)
  covers separately). Likewise, a GitLab `when: manual` anywhere in the job
  clears a push finding even if it belongs to a *different* rule than the
  push-matching one — binding a gate to the specific rule that fires on push is
  rules-list (first-match-wins) semantics that belong to the precise-parse
  version. Declare the deploy job's gate at job level, on the same rule as the
  push trigger.
- Job segmentation follows GitHub Actions (`jobs:` children) and GitLab
  (top-level jobs); an unusual structure, an anchored/`extends` job body, or a
  matrix that moves the deploy elsewhere may not segment cleanly. Push detection
  covers explicit triggers (GitHub `on: push`; GitLab `$CI_PIPELINE_SOURCE ==
  "push"` / `only: pushes`); a GitLab job that relies on the *default* "runs on
  every pipeline" behaviour with no explicit rule is not treated as
  push-firing — declare the deploy job `when: manual` (which this lint reads as
  a gate) so intent is explicit.
- Because a line matcher can't bind a ref to the deploy command, rule (b) treats
  **any** mutable ref in the deploy job as unsafe rather than trying to prove
  it's the deployed one. A job that legitimately needs a mutable checkout for
  *tooling* while deploying a verified artifact will be flagged — restructure it
  (check out the verified tag, or run tooling from a separate job) or suppress
  it deliberately. It keys on the literal name `verified` (a shop that names its
  pointer differently should adjust the pattern).

The biases are toward the safe direction for the deploy path — a false positive
is a two-line review, a false negative ships the wrong bits.
