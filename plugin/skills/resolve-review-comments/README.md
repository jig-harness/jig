# Resolve review comments

Review feedback should end in a clear decision, with fixes verified before a
thread closes. Without a shared procedure, agents can reply to the wrong thread,
close a finding before its fix reaches the pull request, or stop while a reviewer
is still running. This skill handles those decisions and repeats review rounds
until the reviewers settle and no actionable finding remains. It is the
runnable form of the [comment-resolution loop](https://github.com/docomply/jig/blob/main/GLOSSARY.md) in
[M7 — PR lifecycle & review](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/README.md).

## Invariant

Each acted-on thread has an explicit outcome and an attached rationale. Accepted
fixes and findings made moot by those fixes remain open until checks pass and the
push reaches the pull request ([PR](https://github.com/docomply/jig/blob/main/GLOSSARY.md)). This skill never marks
the PR ready or merges it; human review decisions and the merge remain human
checkpoints. A review loop never
reports convergence from unreadable check state or an inactive PR. Every thread
write freshly reads the owning PR and refuses a closed, merged, or unreadable
state, including in standalone installs. This is a check immediately before a
write, not atomic protection: a merge between the read and mutation remains
possible. The caller performing a push owns its separate liveness check.

## Installation

The skill ships in the `groundwork` plugin, installed once per machine for
Claude Code and Codex; see [Groundwork's skills](../../README.md#install-the-plugin).
In a session it is `/groundwork:resolve-review-comments`. Its scripts run from
the plugin directory with [Bun](https://bun.sh) and act on the repository the
agent is working in, so the target repository needs no copy of the skill and
need not use JavaScript. Git and an authenticated GitHub CLI (`gh`) are also
required.

## Consumer configuration

Each repository keeps its values in `.config/groundwork-overlay.yaml` (JSON is
valid YAML, so a JSON-formatted file works too). The scripts read it from the
root of the repository the agent is working in; the procedure starts by
printing it (`scripts/consumer-config.ts`) and stops when it is missing or
invalid. `GROUNDWORK_OVERLAY` points at another file and
`GROUNDWORK_CONSUMER_ROOT` at another repository root; tests use both. Fields
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
| `issue_tracker.labels` | Optional. The repository's label per role; deferral reads `followup` (default `pr-followup`) and `epic` (default `epic`). Checked at step 0 |
| `issue_tracker.team`, `issue_tracker.file_command` | Optional. Shown to the agent for filing follow-up issues by hand |

A minimal configuration:

```yaml
gates:
  command: bun run gates
review:
  bots: ["coderabbitai[bot]"]
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
`.config/review-triage.yaml` (`GROUNDWORK_REVIEW_TRIAGE_CONFIG` points at
another file); absent or unreadable state restores the ordinary acceptance
rubric and reports the anomaly rather than declining uncertain work.
Do not infer another repository's policy from the examples in this skill.

## Usage and optional integrations

Invoke `/groundwork:resolve-review-comments [PR-number]` (Claude Code), or ask
Codex to use the `groundwork:resolve-review-comments` skill. Use `--dry-run` to inspect a plan,
or `--bots-only` for an automated loop. GitHub App authorship defines that flag's
thread filter; consumer bot names do not silently widen it to human threads.

[SKILL.md](SKILL.md) is the operator contract. The
[triage rubric](references/triage-rubric.md) determines materiality and scope;
the [deferral protocol](references/deferral-protocol.md) requires a tracked
follow-up before a deferred thread resolves. The executable deferral adapter
files those follow-ups in Linear directly, through Linear's GraphQL API, with
the credential in `LINEAR_API_TOKEN` or `LINEAR_API_KEY`. It does not go
through the [tracker interface](https://github.com/docomply/jig/blob/main/GLOSSARY.md) that `do-item` and `drive-pr` use, so
another tracker needs its own deferral adapter.

The skill works independently. A sibling `drive-pr` skill, found in the
repository's own `.claude/skills/drive-pr` or else beside this skill in the
plugin, adds lease
fencing, self-inflicted finding labels, summary-only finding checks, and durable
round state. A missing sibling is supported and limitations are reported; a
present but unreadable or incomplete sibling integration fails visibly. Without
that sibling's summary parser, convergence covers inline review threads and
reviewer checks; inspect reviewer summary comments before declaring the entire
PR ready. No convergence exit marks a PR ready or merges it.

## Tests

The complete standalone suite runs on macOS and Linux. Bash-backed network
fixtures skip on Windows; pure mechanism tests still run there. The plugin test
in [tools/plugin](../../../tools/plugin/plugin.test.ts) runs the scripts from a copy
outside this repository, the way a plugin cache holds them, against a scratch
consumer repository.

Run the tests with:

```sh
bun test plugin/skills/resolve-review-comments/__tests__
```

The tests exercise pagination, reply validation, mutation failure handling,
convergence exits, lease integration, bounded cache reuse, triage configuration,
and deferral batching. Repository validation is `bun run gates`.
