# Resolve review comments

Review feedback should end in a clear decision, with fixes verified before a
thread closes. Without a shared procedure, agents can reply to the wrong thread,
close a finding before its fix reaches the pull request, or stop while a reviewer
is still running. This skill handles those decisions and repeats review rounds
until the reviewers settle and no actionable finding remains.

## Invariant

Each acted-on thread has an explicit outcome and an attached rationale. Accepted
fixes and findings made moot by those fixes remain open until checks pass and the
push reaches the pull request ([PR](https://github.com/docomply/jig/blob/main/GLOSSARY.md)). Human review decisions,
marking the PR ready, and merging remain human checkpoints. A review loop never
reports convergence from unreadable check state or an inactive PR.

## Installation and consumer values

Use the [pinned installer](https://github.com/docomply/jig/blob/main/tools/install/README.md) with
`skills: ["resolve-review-comments"]`. The installer exposes the procedure to
Claude Code and Codex and supplies private scripts under
`.claude/skills/resolve-review-comments/scripts/` in either harness. Run scripts
with the consumer's pinned Bun runtime; the target repository need not use
JavaScript. Git and an authenticated GitHub CLI (`gh`) are also required.

The [consumer overlay](https://github.com/docomply/jig/blob/main/GLOSSARY.md) keeps organization values outside the
mechanism. The installer persists `.groundwork/overlay.json` for executable
configuration as well as rendering agent instructions:

| Field | Meaning |
|-------|---------|
| `gates.command` | Complete local checks required before a fix is committed and pushed |
| `review.bots` | Expected reviewer identities for instructions |
| `review.job_pattern` | Regular expression selecting the reviewer checks whose completion permits another round |
| `review.deferral_team` | Linear team used by the deferral adapter |
| `review.repo_slug` | GitHub repository (`owner/name`) used to validate finding permalinks |
| `review.repo_label` | Repository label used on follow-up issues |
| `review.taxonomy` | Consumer label sets: `types`, `repos`, `sizes`, `categories`, `context_prefixes`, and `ownership_prefixes` |

Consumers retain policy stances, change-proportional validation commands,
optional sibling-claim sweep commands, and independent review-agent definitions
in their own instructions. Late-round triage bands remain consumer-owned in
`.config/review-triage.yaml`; absent or unreadable state restores the ordinary
acceptance rubric and reports the anomaly rather than declining uncertain work.
Do not infer another repository's policy from the examples in this skill.

## Usage and optional integrations

Invoke `/resolve-review-comments [PR-number]`. Use `--dry-run` to inspect a plan,
or `--bots-only` for an automated loop. GitHub App authorship defines that flag's
thread filter; consumer bot names do not silently widen it to human threads.

[SKILL.md](SKILL.md) is the operator contract. The
[triage rubric](references/triage-rubric.md) determines materiality and scope;
the [deferral protocol](references/deferral-protocol.md) requires a tracked
follow-up before a deferred thread resolves. The executable deferral adapter
currently targets Linear behind a tracker interface.

The skill works independently. An installed sibling `/drive-pr` adds lease
fencing, self-inflicted finding labels, summary-only finding checks, and durable
round state. A missing sibling is supported and limitations are reported; a
present but unreadable or incomplete sibling integration fails visibly. Without
that sibling's summary parser, convergence covers inline review threads and
reviewer checks; inspect reviewer summary comments before declaring the entire
PR ready. No convergence exit marks a PR ready or merges it.

## Tests

The complete standalone suite runs on macOS and Linux. Bash-backed network
fixtures skip on Windows; pure mechanism tests and bundled link/copy installation
checks still run there. The consumer retains tests using its real optional driver.

Run the moved tests with:

```sh
bun test skills/resolve-review-comments/__tests__
```

The tests exercise pagination, reply validation, mutation failure handling,
convergence exits, lease integration, bounded cache reuse, triage configuration,
and deferral batching. Repository validation remains `bun run gates`.

## Provenance and rollout

Moved from the operated skill at
`.claude/skills/resolve-review-comments/` in docomply's `develop`, source commit
`35495ac78a809342697c1e36f55362378e2b6ff4`. This includes the operated guards and
their tests, rather than replacing them with a parallel implementation. Local
copy-divergence history is retained in source control rather than shipped as a
second procedure.

Rollout acceptance requires an immutable published release and manifest, a
consumer pin verified by the installer, a real review pass from both harnesses,
and deletion of the old operated and standards copies in that same rollout.
Those publication and live-consumer checks remain pending until the release pin
exists; local source and tests alone do not establish rollout completion.
