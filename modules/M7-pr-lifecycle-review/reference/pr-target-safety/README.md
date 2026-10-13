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
2. it checks out a ref it cannot show to be the base: a `ref:` or
   `repository:` input (under a `with:`, in any letter case) naming a
   `pull/` ref, or holding any `${{ }}`
   expression other than the base side of the pull request
   (`github.event.pull_request.base.sha`, `.base.ref`, `.base.repo.full_name`,
   `github.base_ref`, `github.sha`, `github.ref`, `github.ref_name`,
   `github.repository`, `github.repository_owner`,
   `github.event.repository.full_name` or `.default_branch`); and
3. it has an execution path: a `run:` step, or a local action (`uses: ./…`)
   loaded from the checkout.

Omit any one and it passes: a `pull_request_target` job that checks out only the
base is safe; running fork code on plain `pull_request` is safe; a
`pull_request_target` job with neither a `run:` step nor a local action has
no execution path. It is
deliberately **high-recall** — a false positive costs a two-line review; a
false negative costs a leaked secret. That is why point 2 lists what is safe
rather than what is not: the head reaches a checkout through many spellings
(an `env.` variable, a step output, bracket access, the merge ref), and every
one of them is outside the list.

The lint reads each workflow with Bun's YAML parser, so a value is judged as
GitHub sees it, whether it is written folded, quoted, escaped, in a flow
mapping or through an anchor; the trigger is read from the parsed `on:` as
well as the raw text. A file that does not parse fails the lint with exit 2.

A literal `ref:` or `repository:` passes: under `pull_request_target` the
workflow file comes from the base branch, so a literal was written by the
base's maintainers, not by the pull request. The lint looks for values the
pull request controls.

## Mirror it on both rungs

This is a [CI](../../../../GLOSSARY.md) concern by nature (the workflows are the
thing being checked), so run it as a required check on every PR that touches
`.github/workflows/`. A pre-commit run is a nice-to-have; CI is the authority
(see [M1](../../../M1-gates-enforcement-ladder/)).

```sh
WORKFLOWS_DIR=.github/workflows bun ./check-pr-target-safety.ts
```

## Files

| File | Role |
|------|------|
| `check-pr-target-safety.ts` | the gate; `WORKFLOWS_DIR` or file args select inputs |
| `check-pr-target-safety.test.ts` | paired self-test |
| `fixtures/safe/` | base-only checkout, explicit base sha, plain `pull_request`, data-only labeler — must pass |
| `fixtures/unsafe/` | `pull_request_target` + untrusted checkout (head, fork, merge ref, `env.` indirection) + a `run:` step or local action — must fail |

Run the self-test with `bun test ./check-pr-target-safety.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

## Known limits

It parses the workflow but does not evaluate it. What it does not see:

- untrusted code a `run:` script fetches itself (`git fetch` of a pull
  request ref, `gh pr checkout`), or a third-party action that executes the
  checkout with no `run:` step and no local action;
- which job a checkout and an execution path belong to: any untrusted checkout
  and any execution path in the same file count together;
- the trigger's context: the text `pull_request_target` anywhere in the file
  counts as "triggered by it," beside the parsed `on:`.

The last two over-flag, which is the right direction for a security gate; the
first is a gap to close by review. The lint also runs from the tree it checks,
so a pull request that weakens it is checked by its weakened copy; a reviewer
of the change to the lint is the control there.

The native gate uses the shared implementation in Jig’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Jig checkout when adopting it.
