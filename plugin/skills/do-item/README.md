# Do item

Picking up an issue should keep its context, validation and review together.
Without a shared procedure, a started item can lose its findings between
sessions or reach a pull request without the checks its changes need.
`/jig:do-item <issue-key>` takes an issue from the configured tracker (its
key is `ENG-123` on Linear, `#123` on GitHub Issues), checks its context and
human checkpoints, delegates the work, validates it, opens a draft pull
request under the repository's policy and arms
[`drive-pr`](../drive-pr/README.md). A person merges.

## The item's spec

Once it has the issue, it shows what the issue says must be built: the
requirements, acceptance criteria and tasks in its `## Spec`,
`## Requirements` and `## Acceptance criteria` sections, with the ids the
text gives them (`FR-001`, `AC-1`, a numbered checkbox), and each reference
it did not read, with the reason. It reads nothing outside the repository,
nothing Git ignores, and no web link. The heading of the spec section is
`specs.body_section` in the
[configuration](../../CONFIGURATION.md#specs). The list is shown to you;
the rest of the pickup does not depend on it.

## The item's work type

On pickup the skill says what kind of work the item is, its
[work type](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(bug, feature, improvement, task or spike, or the repository's own list in
`issue_tracker.types`), and how it knows: a type label, the tracker's own
issue type (GitHub's issue types), or a Conventional Commits title prefix
such as `fix:` where the repository's titles follow that convention. An item
none of these identifies is `unknown`. Each type has a row in the
[depth table](../../CONFIGURATION.md#the-depth-table). In this version the
type is reported, and the pickup is otherwise the same for every type. A
type configuration the rules refuse stops the pickup, naming the field at
fault, since the route below reads it too.

## The implementer's route

Before it delegates, the skill also says which
[model tier](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) and
which effort the implementing agent should run on, and why: the item's
[route](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). The type
gives a base (a task runs on the Execution tier at low effort, a spike on
the Strategic tier at high effort), and a flag label, an area with a
mandatory review, a size too large to batch and the human-in-the-loop label
each move the effort up one step. The rules are data in the repository's
`routing` section, with defaults
([configuration reference](../../CONFIGURATION.md#routing)). In this version
the route is reported and the implementer runs on the model it ran on
before. A `routing` section the rules refuse stops the pickup, naming the
field at fault, until the repository corrects it.

## Requirements and platforms

Install the [plugin requirements](../../README.md#requirements), and name the
tracker in the repository's `.config/jig.yaml`: `issue_tracker.adapter`, and
on Linear `issue_tracker.team`. The complete
procedure and configuration fields are in [SKILL.md](SKILL.md).

The instructions run in Bash on macOS and Linux, and PowerShell on Windows.
Make Bun, Git and GitHub CLI available to the command tool. Codex substitutes
the installed skill's absolute path for `${CLAUDE_SKILL_DIR}` before running a command. Generated
JSON and comment bodies are read from files, so no Git Bash utilities are needed.

Run every TypeScript script through `bun`, from the consumer repository's
root. For example, using the installed do-item skill directory:

```bash
bun "<skill-dir>/scripts/get_issue.ts" "<issue-key>"
```

Native Windows tests cover the pickup scripts and the drive's process
helpers. The complete interactive Windows smoke test — pick an item,
open its draft pull request, arm a drive, finish a pass and stop the drive —
is still pending. Automated component coverage does not establish that
interactive flow.

## Arming the drive

Once the pull request opens, the skill starts its
[drive](../drive-pr/README.md), the unattended loop that works the review
rounds, through drive-pr's `arm-drive.ts`, the same way `/jig:drive-pr`
does. `do_item.arm_drive` in the
[configuration](../../CONFIGURATION.md#do_item) says how: `auto`, the
default, opens a terminal tab of the pull request's workspace where the
session can (in Orca, below) and uses the session's background execution
elsewhere; `tab`, `background` and `print` (the command only) choose one.
Each round's agent runs on `drive.pass_model`
([configuration](../../CONFIGURATION.md#drive)): `sonnet`, Claude Code's
alias for the latest Sonnet, unless you name a model, an alias or a
routing tier. The skill reports the command, the model, the driver log and
the commands that list and stop the drive. An issue that waits on a person's
decision gets the command only.

## Continuing work

Invoke the same skill with the issue key again. It refreshes tracker state,
checks whether prior findings can be reused and writes this session's intent
snapshot. An issue with children selects one eligible child at a time; human
checkpoints remain in force. Once a pull request exists, the drive owns its
review rounds. See [the drive's README](../drive-pr/README.md) for inspecting
or stopping it.

## In Orca

Run in a worktree of [Orca](https://www.onorca.dev), the skill also moves
the worktree's card on Orca's workspace board, which the desktop app and
Orca Mobile show: to In progress when it starts the issue, and to In review,
with the pull request linked, once the pull request opens. Nothing turns
this on and nothing in another runtime changes: outside Orca it makes no
call, and an Orca call that fails only warns.

A repository can also have the workspace renamed at each stage, from a
template over the item key, title, pull request and a short status (`[I]`
implementing, `[D]` driving, `[R]` ready to merge, `✅` done): set
[`workspace_name`](../../CONFIGURATION.md#workspace_name). Nothing is renamed
without it.

It also arms the drive in a terminal tab of its own in the workspace, titled
`drive #<PR>`, so the drive outlives the session, a person can watch its
rounds, and the session that implemented the item ends without a drive
running beside it. The tab is a fresh login shell of yours, so `bun`,
`claude` and the Claude account or profile the drive uses come from it, not
from the session. If Orca cannot open the tab, or the tab's drive does not
show up in time, the drive starts in the background as it does elsewhere,
and the skill says why. On a Windows host the drive always starts in the
background: Orca's tab there can run `cmd.exe` or PowerShell, and the
command is written for a POSIX shell.

Orca's own Linear skill (`orca-linear`) has a completion flow of its own.
Inside this skill the ticket's comments and transitions stay with `do-item`,
so that flow is not run beside it.
