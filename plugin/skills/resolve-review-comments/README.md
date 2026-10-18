# Resolve review comments

Review feedback should end in a clear decision, with fixes verified before a
thread closes. Without a shared procedure, agents can reply to the wrong thread,
close a finding before its fix reaches the pull request, or stop while a reviewer
is still running. This skill handles those decisions and repeats review rounds
until the reviewers settle and no actionable finding remains. It is the
runnable form of the [comment-resolution loop](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) in
[M7 — PR lifecycle & review](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md).

## Invariant

Each acted-on thread has an explicit outcome and an attached rationale. Accepted
fixes and findings made moot by those fixes remain open until checks pass and the
push reaches the pull request ([PR](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)). This skill never marks
the PR ready or merges it; human review decisions and the merge remain human
checkpoints. A review loop never
reports convergence from unreadable check state or an inactive PR. Every thread
write freshly reads the owning PR and refuses a closed, merged, or unreadable
state, including in standalone installs. This is a check immediately before a
write, not atomic protection: a merge between the read and mutation remains
possible. The caller performing a push owns its separate liveness check.

## Outcomes

Every thread ends with exactly one of the outcomes below, and the reply that
settles it opens with the outcome in bold (`**deferred** — …`), so a script can
read the decision without guessing from the prose. `reply-to-thread.ts`
refuses a reply that does not open with one, unless it is passed
`--no-outcome` for a reply that settles nothing, such as a clarifying
question.

| Outcome | When | Code changes | Thread resolves | Leaves behind | What it says about the reviewer |
|---------|------|--------------|-----------------|---------------|---------------------------------|
| `accepted` | The finding is real, and worth fixing in this pull request | A minimal fix, and the same fix on its siblings | Only after the checks pass and the fix is pushed | The fix commit | A hit |
| `rejected` | The finding is wrong, already handled, or intended | None | At once | The reason, citing the code, decision record or test | A false positive |
| `wont-fix` | The finding is real but optional: the [triage rubric](references/triage-rubric.md) says the change costs more than it is worth here | None | At once | The rubric row that declined it, and a count in the round report | A hit, on something that did not matter enough |
| `deferred` | The finding is real and must be fixed some day, but not in this pull request: it widens the scope, needs a decision the agent may not make, or depends on other work | None | At once, once the follow-up issue's link is on the thread | A tracked follow-up issue ([deferral protocol](references/deferral-protocol.md)) | A hit, on work still owed |
| `moot` | The finding no longer applies: its code was removed or rewritten, another fix covered it, or it repeats a thread fixed elsewhere | None | At once; if this round's unpushed fix is what made it moot, with that fix | What made it moot | Neither: the reviewer may have been right about code that is gone |

The rubric and the [Review Arbiter](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
decide the outcome; a person decides only what the arbiter escalates. A thread
whose outcome changes in a later round gets a new reply with the new outcome,
so the thread keeps its history.

The outcomes that decline a fix look alike and mean different things,
and confusing them sends the wrong signal:

- `rejected` says the reviewer was **wrong**. Calling a correct finding
  `rejected` teaches the reviewer to stop raising findings it got right.
- `wont-fix` says the reviewer was **right** and the change is deliberately
  not made. No issue is filed; filing one for optional polish fills the
  tracker with follow-ups nobody needs.
- `deferred` says the reviewer was **right** and the work is **owed**. It is
  the only outcome that leaves work behind, so nothing is deferred without a
  tracked issue.

### What the outcomes are for

Because each outcome is written down when the thread is answered, the replies
are data that these readers can use:

- **Planning.** Deferred findings arrive in the tracker as follow-up issues
  with the repository's `followup` label, by default grouped into one issue
  per pull request and type of work (a finding that needs its own design
  decision, whose fix sizes above `small`, or that belongs to another owner
  or domain gets an issue of its own, with the reason recorded), linked to the pull
  request. A follow-up is filed under the epic its work item belongs to when
  that epic shares the finding's domain, and with no parent otherwise
  ([deferral protocol](references/deferral-protocol.md)). M7's
  [post-merge stage](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md#core-pieces)
  checks after the merge that each one was filed. Deferrals that keep landing on the same area point
  to a design gap rather than to one pull request's scope.
- **The reviewer.** Counted per reviewer, the outcomes measure it: its
  precision is the share of its scored findings that were real (`accepted`,
  `wont-fix` and `deferred` against `rejected`; `moot` counts neither way).
  A high `wont-fix` share says it raises real but minor points, so its
  severity needs tuning; a high `rejected` share in one category says which of
  its checks to fix. That precision is what an automated reviewer must reach,
  its [precision bar](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  before it may block a merge
  ([M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md),
  [M8's parity report](https://github.com/jig-harness/jig/blob/main/modules/M8-learning-loop/reference/parity-report/README.md)).
- **The repository.** Findings accepted again and again in the same class
  are misses the author's own review should have caught. The
  [learning loop](https://github.com/jig-harness/jig/blob/main/modules/M8-learning-loop/README.md)
  turns such a miss into a new check, so the next pull request does not
  need the reviewer for it.

Jig enforces the outcome on every reply that settles a thread and ships the pieces either side of
the count: M7's [export adapter](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/reference/comment-resolution/README.md),
which reads the outcome of each thread on one pull request, and M8's parity
report, which turns per-reviewer counts into precision, recall and missed
blockers. It does not yet ship the step between them, which collects the
outcomes across pull requests and counts them per reviewer: a repository
writes that itself. The outcomes supply only the true and false positives: a
blocker the reviewer never raised has no thread and so no outcome, and its
missed-blocker count comes from comparing the reviewer with an independent
oracle. The export adapter reports `wont-fix` as `rejected`,
which is right for its question (is every thread closed?) and wrong for
scoring, so a counting script reads the outcome word from the replies
themselves. It counts only the last reply on each thread that opens with an
outcome word and was written by an `OWNER`, `MEMBER` or `COLLABORATOR` of the
repository: an outcome can change, and a review thread is open to anyone's
comments, so an earlier or outside reply is not the decision
([triage rubric § Contradictory findings](references/triage-rubric.md#contradictory-findings)).

## Installation

The skill ships in the `jig` plugin, installed once per machine for
Claude Code and Codex; see [Jig's skills](../../README.md#install-the-plugin).
In a session it is `/jig:resolve-review-comments`. Its scripts run from
the plugin directory with [Bun](https://bun.sh) and act on the repository the
agent is working in, so the target repository needs no copy of the skill and
need not use JavaScript. Git and an authenticated GitHub CLI (`gh`) are also
required.

## Consumer configuration

Each repository keeps its values in `.config/jig.yaml` (JSON is
valid YAML, so a JSON-formatted file works too). The scripts read it from the
root of the repository the agent is working in; the procedure starts by
printing it (`scripts/consumer-config.ts`) and stops when it is missing or
invalid. `JIG_OVERLAY` points at another file and
`JIG_CONSUMER_ROOT` at another repository root; tests use both. Fields
the skill does not read are ignored, so a configuration shared with other
tooling can carry more.

| Field | Meaning |
|-------|---------|
| `gates.command` | Required. Complete local checks required before a fix is committed and pushed |
| `review.bots` | Required. Expected reviewer identities for instructions |
| `review.job_pattern` | Regular expression selecting checks to wait on; requires `review.required_checks`. Absent or `null`: reviewer checks are recognised by name |
| `review.required_checks` | Distinct exact check names that must each complete; missing or skipped members cannot settle |
| `review.deferral_team` | Required. Linear team used by the deferral adapter |
| `review.repo_slug` | GitHub repository (`owner/name`) used to validate finding permalinks; a deferral without it needs `--repo-slug` |
| `review.repo_label` | Repository label used on follow-up issues, one of `review.taxonomy.repos`; a deferral without it needs `--repo-label` |
| `review.taxonomy` | Consumer label sets used when filing deferred findings: `types`, `repos`, `sizes` (default `xs`, `small`), `categories`, `context_prefixes`, and `ownership_prefixes` (required once `types`, `repos` or `context_prefixes` is set). `provenance_label` and `epic_label` are older spellings of the `followup` and `epic` roles in `issue_tracker.labels`; set either one, or both to the same name |
| `review.severity_formats` | Optional. How a reviewer writes a finding's severity, for one with no built-in format or words a built-in one does not read (entries are tried first; the built-in formats still apply after them), so the decline ladder can use it ([severity formats](../../EXTENDING.md#severity-formats)) |
| `issue_tracker.labels` | Optional. The repository's label per role; deferral reads `followup` (default `pr-followup`) and `epic` (default `epic`). Checked at step 0 |
| `issue_tracker.team`, `issue_tracker.file_command` | Optional. Shown to the agent for filing follow-up issues by hand |

A minimal configuration:

```yaml
gates:
  command: bun run gates
review:
  bots: ["example-review[bot]"]   # your review bot's GitHub login
  deferral_team: ENG
```

Declare required coverage explicitly whenever `job_pattern` is set (including
when supplied with `--job-pattern`). Patterns select checks; regex alternatives
do not declare required membership. For example:

```json
{
  "review": {
    "job_pattern": "Primary review|Secondary review|Fallback review",
    "required_checks": ["Primary review", "Secondary review"]
  }
}
```

Here both required checks must complete with a passing or neutral conclusion.
Missing required checks keep waiting (exit `4` under `--once`), even with
`--no-ci`; skipped required checks fail (exit `7`). A selected optional fallback
may be absent or skipped, but an observed running or failed fallback still
blocks convergence. Each required name must match the selection pattern;
invalid coverage configuration exits `2`. Check names are exact and case
sensitive: consumers own names and changes to them. `required_checks` also works
without a pattern and supports check names outside the default reviewer heuristic.
Without either field, checks are recognised by the reviewer-name heuristic,
which does not guarantee coverage of a consumer-defined reviewer set.

Consumers retain policy stances, change-proportional validation commands,
optional sibling-claim sweep commands, and any review-agent definition of their
own (the plugin ships the `review-arbiter` agent) in their own instructions. Late-round triage bands remain consumer-owned in
`.config/review-triage.yaml` (`JIG_REVIEW_TRIAGE_CONFIG` points at
another file); absent or unreadable state restores the ordinary acceptance
rubric and reports the anomaly rather than declining uncertain work.
The bands decline by priority tier, and a finding's tier comes from the kind of
file it sits on, not the pull request's kind: a finding on a gate script in a
docs pull request is tier 1 (CI pipelines and quality gates), and a test that
cannot fail ranks with the gates rather than with tests. Docs and tests are
declined first.
Do not infer another repository's policy from the examples in this skill.

## Usage and optional integrations

Invoke `/jig:resolve-review-comments [PR-number]` (Claude Code), or ask
Codex to use the `jig:resolve-review-comments` skill. Use `--dry-run` to inspect a plan,
or `--bots-only` for an automated loop. GitHub App authorship defines that flag's
thread filter; consumer bot names do not silently widen it to human threads.

[SKILL.md](SKILL.md) is the operator contract. The
[triage rubric](references/triage-rubric.md) determines materiality and scope;
the [deferral protocol](references/deferral-protocol.md) requires a tracked
follow-up before a deferred thread resolves. The executable deferral adapter
files those follow-ups in Linear directly, through Linear's GraphQL API, with
the credential in `LINEAR_API_TOKEN` or `LINEAR_API_KEY`. It does not go
through the [tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) that `do-item` and `drive-pr` use, so
another tracker needs its own deferral adapter.

Where the repository turned on the [`changelog`](../changelog/README.md) skill
(`changelog.file` in the `.config/jig.yaml` its base branch holds), an accepted fix that changes
what the pull request's change note says updates the note in the same commit; a
repository that did not is never asked for one.

The skill works independently. A sibling `drive-pr` skill, found in the
repository's own `.claude/skills/drive-pr` or else beside this skill in the
plugin, adds lease
fencing, self-inflicted finding labels, summary-only finding checks, and durable
round state. A missing sibling is supported and limitations are reported; a
present but unreadable or incomplete sibling integration fails visibly. Without
that sibling's summary parser, convergence covers inline review threads and
reviewer checks; inspect reviewer summary comments before declaring the entire
PR ready. No convergence exit marks a PR ready or merges it.

## Platform support

The skill is tested end to end on macOS and Linux. On Windows its scripts'
own logic is tested, but not their calls to GitHub.
