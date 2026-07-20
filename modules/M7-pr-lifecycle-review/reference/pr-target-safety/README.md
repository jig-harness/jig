# PR-target safety lint

A security gate for the one wiring mistake that turns an automated PR reviewer
into a secret-leak: giving a fork's code both **repository secrets** and a way
to **run**.

## Why it exists

An automated reviewer needs secrets (a model key, a bot token) to do its job,
so its workflow runs on the `pull_request_target` trigger — which, unlike plain
`pull_request`, executes in the **base** repository's privileged context
(secrets + a write token) *even for pull requests opened from forks*. That is
exactly what you want for *posting* a review. It becomes dangerous the moment
the same job also **checks out the untrusted fork code and runs it** (a `run:`
step, or an `npm install` that fires package lifecycle scripts): the fork's own
code now executes with your secrets in scope and can steal them. This is a
well-documented [CI](../../../../GLOSSARY.md) foot-gun.

The safe shape is the harness's **containment guard** made concrete: under
`pull_request_target`, treat fork code as *data* — analyze the diff, never
execute the PR's own code in the privileged job. Work that must run the PR's
build belongs on the `pull_request` trigger (no secrets for forks), handing
results back via artifacts.

## Mechanism

The lint flags a workflow only when **all three** hold:

1. it is triggered by `pull_request_target`; and
2. it checks out an untrusted head/fork ref (a `ref:` / `repository:` line
   referencing `github.event.pull_request.head.*` or `github.head_ref`); and
3. it contains at least one `run:` step (an execution path).

Omit any one and it passes: a `pull_request_target` job that checks out only the
base is safe; running fork code on plain `pull_request` is safe; a
`pull_request_target` job with no `run:` step has no execution path. It is
deliberately **high-recall** — a false positive costs a two-line review; a
false negative costs a leaked secret.

## Mirror it on both rungs

This is a [CI](../../../../GLOSSARY.md) concern by nature (the workflows are the
thing being checked), so run it as a required check on every PR that touches
`.github/workflows/`. A pre-commit run is a nice-to-have; CI is the authority
(see [M1](../../../M1-gates-enforcement-ladder/)).

```sh
WORKFLOWS_DIR=.github/workflows ./check-pr-target-safety.sh
```

## Files

| File | Role |
|------|------|
| `check-pr-target-safety.sh` | the gate; `WORKFLOWS_DIR` or file args select inputs |
| `test-check-pr-target-safety.sh` | paired self-test |
| `fixtures/safe/` | base-only checkout, plain `pull_request`, data-only labeler — must pass |
| `fixtures/unsafe/` | `pull_request_target` + untrusted checkout + `run:` — must fail |

Run the self-test with `./test-check-pr-target-safety.sh`.

## Known limits

Bash pattern-matching, not a YAML evaluator: it will not catch untrusted
execution smuggled purely through a third-party `uses:` action (no `run:`
step), and it treats the presence of `pull_request_target` anywhere in the file
as "triggered by it." Both bias toward over-flagging, which is the right
direction for a security gate; a precise-parse version belongs in whatever
language the repo already uses (see [M3](../../../M3-change-area-catalog/)'s
same reasoning about graph jobs).
