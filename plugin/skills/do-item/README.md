# Do item

Picking up an issue should keep its context, validation and review together.
Without a shared procedure, a started item can lose its findings between
sessions or reach a pull request without the checks its changes need.
`/jig:do-item <issue-key>` takes an issue from the configured tracker (its
key is `ENG-123` on Linear and Jira, `#123` on GitHub Issues), checks its context and
human checkpoints, delegates the work, validates it, opens a draft pull
request under the repository's policy and arms
[`drive-pr`](../drive-pr/README.md). A person merges.

Before the pull request opens, a review gate runs tiered checks over the
change, skipped for a change under 20 non-test lines. Its semantic tier
runs the same [review lenses](../review/README.md) as `/jig:review`, from a
base snapshot of its own: each lens the diff triggers runs with fresh
context, the gate's summary says why it skipped the others, and the lenses'
warnings go into the pull request body under Review Notes.

## Scouts before a pickup

At pickup, a claim about a third-party tool is checked against the version in
use or its documentation before implementation is delegated. The status names
the claim, check, version and result. A false premise stops the pickup for the
user to re-scope; issues about the repository's own code skip this check.

Run `/jig:do-item scout <issue-key>` to gather context before deciding to
start an issue, or `/jig:do-item scout --text <task>` for work outside the
tracker. Both use the same configured scouts and agent routing as a pickup;
free text uses title keywords or the default agent because it has no labels.
Neither claims or implements the work.

The issue form posts completed findings with the `## Scout Findings (<hash>)`
heading a pickup reads, so a later pickup reuses them while their hash matches
or they are under 24 hours old. The text form prints its findings without
contacting the tracker. A route without scouts is reported without an empty
comment, and partial findings from a failed scout are reported without being
published as reusable findings.

Before opening, the pull-request planner warns about merge commits that bring
in work outside the planned base, listing the foreign commits. When a
change-area catalog is configured, it adds the directly touched areas' tracker
labels and flags alongside the fixed `pull_requests.labels`; implied areas
add none. Labels must already exist in the repository. An unreadable history
or configured catalog stops planning.

A repository can also carry the issue's own signals onto the pull request:
`pull_requests.labels_from_issue` maps an issue label (in any case) to a
pull-request label, and `pull_requests.reviewers_from_issue` to the
reviewers to request, logins or `org/team`, with or without `@`. A change
area's `pr: { labels, reviewers }` does the same for every pull request that
touches the area, for a need that follows the paths when the label lags
behind them. A mapped label the repository does not have stops planning,
naming it. Reviewers requested on a draft are notified only once it is
marked Ready, which `pull_requests.mark_ready` decides
([configuration](../../CONFIGURATION.md#reviewers-on-a-draft)).

## Implementation guidance

A repository that sorts its work by kind of change (a schema migration, an
API contract change, a UI change) can give each kind its skills and notes,
whichever agent implements it. `do_item.guidance` lists them in the shape of
the review gates: an entry applies when the issue carries one of its labels
or the change touches one of its paths. A change area adds the same with
`implementation: { skills, notes }`, and its own `notes` come with it. The
skill hands the union of what matches to the implementing agent under
`## Implementation guidance`, in the order the entries are written. A skill
name that resolves to nothing installed is named in the status message, and
the audit refuses it. Guidance never replaces a review gate; guidance that
every item needs belongs in the repository's own agent instructions.

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

The `## Verification` section carries proposed command lines, in lists or
code blocks. Its heading is configurable with `specs.verification_section`.
The resolver lists each command with its source key and passes it to the
implementer as untrusted tracker text. It never executes commands. The
implementer reviews what each command does and records each command it
chooses to run through the [evidence recorder](../../shared/evidence.ts),
keeping the resulting record reference with its validation report.

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

Before it delegates, the skill also says which complexity tier (simple,
standard or complex) and which effort the implementing agent should run on,
and why: the item's
[route](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). The
tier comes from the item's type and size (a bug, improvement or feature is
standard up to M and complex from L, a task is simple up to L and standard
at XL, a spike is complex at any size, and an unknown size reads as M),
and a complex flag label, on the item or declared by an area it seeds, makes
it complex at any size. The effort starts from the type's base, and a flag
label, an area with a mandatory review, a size too large to batch and the
human-in-the-loop label each move it up one step. The tier maps to a model
per vendor. The rules are data in the repository's `routing` section, with
defaults ([configuration reference](../../CONFIGURATION.md#routing)). In
this version the route is reported and the implementer runs on the model it
ran on before. A `routing` section the rules refuse stops the pickup,
naming the field at fault, until the repository corrects it.

## The claim

Before it starts the work, the skill claims the item: it assigns it to
itself (the user its tracker credentials act as) and moves it to the
in-progress state. It refuses an item already in progress or assigned to
someone else, and stops when reading the item back shows another claim
landed first, so a manual pickup and a dispatched one rarely work on one
item side by side. A tracker has no conditional write, so two claims
racing inside that re-read can both pass; the
[dispatcher](../../README.md#the-dispatcher) reports an item two running
sessions work on.

A dispatcher pickup serving a named person uses `claim --for <identity>`.
It verifies that a repository writer made the assignment, keeps the person
as the sole assignee, and moves the item in progress. With
`--ancestor <epic-key>`, it walks the current ancestry, rejects holds or
conflicting assignees, and checks the ancestor epic's assignment. GitHub
adds the person to an unassigned child without replacing a concurrent
assignee. Linear and Jira hold one assignee and have no write that applies
only to an unassigned item, so there the claim assigns the child, then reads
the item's history: if the assignment replaced someone who was assigned in
between, it puts them back. Either way a detected race stands down and
refreshes the queue.

Command-line claims share a machine-local mutex across worktrees and
re-read authority before writing. That does not serialize claims on
separate hosts: two hosts claiming for the same person write the same
assignee and state, so the re-read cannot tell them apart. The claim marker
can (`do_item.claim_marker`, below): set it wherever more than one host
picks up from one queue. The dispatcher's double-claim watch stays as the
backstop.

### The repository's own start rules

A team whose items carry their own start rules (the item names this
repository, its driver is an agent, every blocker is finished) states them as
one command, `do_item.preflight_command`. Every claim runs it first, before
the claim lock and before anything is written, so `do-item`, `work-batch` and
a dispatched pickup all honour it without any of them remembering to call it.
It reads the item's JSON on standard input. Exit 0 lets the claim go on. Exit
3 refuses it: the claim exits 3, nothing is written, and the first line the
command printed is the reason. Any other exit, or a run past 60 seconds,
refuses too. The command text is read from the default branch, so a branch cannot
change the command its own claim runs; the command runs in the current
checkout, so a program it names inside the repository (`bun
scripts/start-rules.ts`) is the branch's own copy, and the rules are only as
trusted as that program: a branch can bypass a rule by editing a script the command runs, so name an executable that is trusted independently of the branch, such as one installed on the machine. It runs without the tracker and forge tokens. Telling the agent to proceed does not clear a refusal: the
item or the command changes. A dispatched pickup the command refused shows
in the dispatcher's queue as held, with the reason, until the item changes.

More settings narrow a claim, read from the default branch like the command, so a branch cannot widen its own allowed states or switch off the marker. `do_item.claim_from` names the states work
may start from: an item in any other state, or in a status that maps to no
canonical state, is refused with nothing written, so a side state a team
uses as its record of why work stopped is never cleared by a claim.
`do_item.claim_marker` posts a marker comment on each item a claim starts,
naming the session, the host and the branch, so other tools reading the
tracker can tell which session holds it. The claim posts it before it
writes anything else and reads the item's markers back. When another
claim's marker posted in the last 10 minutes is earlier, it removes its own
and refuses, with nothing written to the item. It does the same when its
marker cannot be posted or read back. That makes the marker the token two
hosts claiming one item agree on. The tracker offers no conditional write
for a comment, so two claims whose reads each miss the other's marker can
both win; the read after the claim narrows that to the claim's own few
seconds. The settings are in the
[configuration](../../CONFIGURATION.md#do_item).

## Requirements and platforms

Install the [plugin requirements](../../README.md#requirements), and name the
tracker in the repository's `.config/jig.yaml`: `issue_tracker.adapter`, and
on Linear `issue_tracker.team`. The complete
procedure and configuration fields are in [SKILL.md](SKILL.md).

The instructions run in Bash on macOS and Linux, and PowerShell on Windows.
Make Bun, Git and GitHub CLI available to the command tool. Codex substitutes
the installed skill's absolute path for `${CLAUDE_SKILL_DIR}` before running a command. Generated
JSON and comment bodies are read from files, so no Git Bash utilities are needed.
Codex delegates with its subagent tool and the routed agent's instructions,
falling back to the current session when that tool is unavailable. The drive
uses Codex's pass command, started in a terminal tab or through its managed
background command tool; see [how to start it](../drive-pr/README.md#how-to-start-it)
for session lifetime and model overrides.

Run every TypeScript script through `bun`, from the consumer repository's
root. For example, using the installed do-item skill directory:

```bash
bun "<skill-dir>/scripts/get_issue.ts" "<issue-key>"
```

`get_issue.ts` keeps exit `2` and `found: false` for both an absent issue
and an unreadable tracker answer. Its JSON `reason` distinguishes `not-found`
(with key and team suggestions) from `read-failed` (the tracker failure,
without those suggestions).

Native Windows tests cover the pickup scripts and the drive's process
helpers. The complete interactive Windows smoke test — pick an item,
open its draft pull request, arm a drive, finish a pass and stop the drive —
is still pending. Automated component coverage does not establish that
interactive flow.

## Arming the drive

Before starting the drive, the skill detaches the implementer's isolated
worktree after its branch is pushed, it is clean and no git operation remains.
A tree with changes, unpushed commits or unreadable safety evidence stays
attached; the report names it and gives inspection and release commands.
The session's own tree stays attached.

Once the pull request opens, the skill starts its
[drive](../drive-pr/README.md), the unattended loop that works the review
rounds, through drive-pr's `arm-drive.ts`, the same way `/jig:drive-pr`
does. `do_item.arm_drive` in the
[configuration](../../CONFIGURATION.md#do_item) says how: `auto`, the
default, opens a terminal tab of the pull request's workspace where the
session can (in Orca, below) and uses the session's background execution
elsewhere; `tab`, `background` and `print` (the command only) choose one.
A Claude Code round uses `drive.pass_model`
([configuration](../../CONFIGURATION.md#drive)), defaulting to `sonnet`,
and the extra arguments in `drive.pass_args` (none unless this host's
[user file](../../CONFIGURATION.md#a-hosts-opt-in-to-bypass) sets them).
A Codex round uses `routing.models.codex.standard` (by default `terra`,
given as `gpt-5.6-terra`), carries its bypass only
on a host that set `drive.codex_bypass`, and carries the extra arguments in
`drive.codex_pass_args` before its prompt; it does not read
`drive.pass_model` or `drive.pass_args`. For either runtime, `--pass-model`
overrides the model for one drive, resolving a complexity tier through that
runtime's row of `routing.models` (see [drive-pr](../drive-pr/README.md)).
The skill reports
the command, the model, the permission mode, the driver log and the
commands that list and stop the drive. An issue that waits on a person's
decision gets the command only.

## Review and finish

A repository whose board separates work being written from work waiting
for review can name an optional `pr_open` state in `issue_tracker.states`.
Once the pull request opens, the skill posts the comment linking it on the
item, then moves the item there, before the drive arms. The parent roll-up
reads `pr_open` as work still in progress, not as merged: `in_review` keeps
that meaning. A tracker with one review status, used while the pull request
is open and after the merge, gives `pr_open` and `in_review` the same name.
The tracker cannot say which wait an item under that name is in, so the
roll-up asks the code host (`scripts/linked-pr.ts`): an item whose linked
pull request merged reads as `in_review`, and one whose pull request is
open, that has none, or whose pull request cannot be read reads as
`pr_open`. Under distinct names nothing is read from the code host. Without
`pr_open`, nothing moves before the merge.

After the merge, the item moves to `done`, or to `ops_pending` while a
manual step remains. A team whose `done` means merged and verified by
someone else sets `do_item.post_merge_state` to `in_review` or
`ops_pending`: no agent then moves the item further, and the closing comment
says who closes it (`do_item.post_merge_closer`). That needs
`pull_requests.issue_link: refs`, since a `Closes` link lets the forge close
the item on merge whatever the skill does. Every post-merge move passes
`--post-merge` to the tracker script, which refuses a move to `done` the
setting forbids; a person's own move without the flag still works. The
[configuration reference](../../CONFIGURATION.md#do_item) has both
settings.

## Stopped work

A team whose board shows stopped work as blocked can name an optional
`blocked` state in `issue_tracker.states`. With the pull request state
labels on (`dispatch.labels.enabled`), a drive that stops with only parked
work left moves each item its pull request links to `blocked`, with a
comment naming each park's class and reason; on Jira it also writes the
fields `issue_tracker.jira.blocked_fields` names, sending those the
transition's screen carries with the move, so a transition that requires
one accepts it. Once the park is answered
and the drive runs again, the item returns to the state it left. This
skill never moves an item into or out of `blocked`, and its claim refuses
an item there. The [configuration reference](../../CONFIGURATION.md#issue_tracker)
has the rules.

## Continuing work

Invoke the same skill with the issue key again. It refreshes tracker state,
checks whether prior findings can be reused and writes this session's intent
snapshot. If the earlier pickup of an issue was interrupted, the issue is
already in progress and assigned to you, so the claim refuses it: say in
your request that you are resuming your own pickup, and the skill goes on
without the claim. An issue held by another session stays refused. An issue with children selects one eligible child at a time; human
checkpoints remain in force. Once a pull request exists, the drive owns its
review rounds. See [the drive's README](../drive-pr/README.md) for inspecting
or stopping it.

## In Orca

Run in a worktree of [Orca](https://www.onorca.dev), the skill also moves
the worktree's card on Orca's workspace board, which the desktop app and
Orca Mobile show: to In progress when it starts the issue, and to In review,
with the pull request linked, once the pull request opens; the
[drive](../drive-pr/README.md) moves it on from there. A
board with custom columns maps these stages onto them in
[`orca.board`](../../CONFIGURATION.md#orca). Nothing turns this on and
nothing in another runtime changes: outside Orca it makes no call, and an
Orca call that fails only warns.

In Herdr as well as Orca, the workspace is renamed as the work moves, from a template over the item key, title, pull request and a short status (`[I]`
implementing, `[D]` driving, `[R]` ready to merge; `✅` done is reserved for
a follow-up step and nothing sets it yet), `{id} {status} {title} {pr}` by
default: [`workspace_name`](../../CONFIGURATION.md#workspace_name) changes the
template, and `template: ""` turns the renaming off.

It also arms the drive in a terminal tab of its own in the workspace, titled
`drive #<PR>`, so the drive outlives the session, a person can watch its
rounds, and the session that implemented the item ends without a drive
running beside it. The tab closes when the drive ends, unless the drive
parked or failed and needs you. The tab is a fresh login shell of yours, so `bun`,
`claude` and the Claude account or profile the drive uses come from it, not
from the session. If Orca cannot open the tab, or the tab's drive does not
show up in time, the drive starts in the background as it does elsewhere,
and the skill says why. On a Windows host the drive always starts in the
background: Orca's tab there can run `cmd.exe` or PowerShell, and the
command is written for a POSIX shell.

Orca's own Linear skill (`orca-linear`) has a completion flow of its own.
Inside this skill the ticket's comments and transitions stay with `do-item`,
so that flow is not run beside it.

## Jira workflows by issue type

When Jira issue types use different workflows, configure
`issue_tracker.jira.states_by_type` with each type’s overrides on
`issue_tracker.states`. The parent roll-up reads each child’s workflow and
moves the parent through its own status names. An explicit `null` marks a
state absent from that workflow; the move is skipped and reported.
The tracker’s states command prints the repository map and each configured type’s
effective map. See the [configuration reference](../../CONFIGURATION.md#issue_tracker).
