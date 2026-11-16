# A follow-up skill for every repository: design

**What problem this solves.** The dispatcher starts a repository's
`dispatch.followup_command` after each merge, but the plugin shipped no
command for it to start. The dispatcher hands that command to the agent as
the first line of the pass's prompt, so it can name a skill in the
repository, one in the user's home or one an installed plugin brings, or
have the agent carry out a procedure from a script or a prompt file the
repository keeps. Whatever its form, every repository that wanted the
post-merge stage supplied its own, and each restated the same protocol by
hand: claim the
follow-up with a marker, check the claim before every write outside the pull
request, record one verdict per class of obligation with its evidence, tag
a routine question, end as done, a wait or a failure. A restated protocol
drifts from the dispatcher it serves, and a repository without the time to
write one runs no post-merge stage at all. With this built, any repository
names `/jig:followup` and gets the whole stage; a repository with
obligations of its own adds them as arms without restating the rest.

This is the design of [plan.md](plan.md) item 17's M7 bullet. The first
layer and the second ship as the plugin's
[followup](../plugin/skills/followup/README.md) skill.

## How it works

The skill is layered, each layer changed by a different owner, so that what
every repository must do the same way cannot be changed by what one
repository adds.

| Layer | What it holds | Who changes it |
|---|---|---|
| **Protocol** (`followup.ts facts · arms · record · guard · settle`) | The merge facts and diff range; the marker check before every outside write; one verdict per arm, with evidence; the settle step that refuses to end a run with an arm unrecorded; the preview on an open pull request; how a run ends | Jig only |
| **Core arms** | The tracker item and epic, deferred findings, out-of-tree steps, the release (where `changelog.file` is set), scaffolding and live drivers, live verification (with the change areas' post-deploy actions), the next step, the workspace board (in Orca only) | Jig; a repository turns one off with `followup.off` |
| **Repository arms** | `followup.arms[]`: when an arm applies (by change area), and what settles it, in one of three forms: an instructions (prompt) file read from the default branch, a read-only check command whose verdict JSON the protocol records like any other, or a skill from any source named by its slash command and run by the same agent | The repository |

### The protocol is a script

The dispatcher's prompt (`followupPrompt` in
`plugin/dispatch/lib/session.ts`) and its routine question classes
(`routine-questions.ts`) are the contract a follow-up must keep. Prose that
restates a contract keeps it only as long as every reader applies every
sentence; a script keeps it whatever the agent skips. So the steps whose
order and outcome must not vary are commands:

- `facts <PR>` reads the pull request once and decides the mode: merged is
  the post-merge run, open is a preview, anything else is refused. The
  integration branch comes from configuration (or the remote's HEAD), and a
  merge into any other base (except one `pull_requests.base_rules` names)
  is refused, since the obligations the arms check follow a merge into the
  integration branch. The diff range is read from the merge commit's
  parents, so a squash merge and a merge commit both give the change the
  merge brought in.
- `record` writes each verdict into a per-run ledger under
  `.context/scratch/followup/`, and refuses one without evidence: "nothing
  found" is not a reason, and the ledger is where that rule is enforced.
- `guard` wraps `jig dispatch marker check`, so "check before every outside
  write" is one command with one exit to read, and a preview, which writes
  nothing outside the pull request, is refused before anything is asked.
- `settle` refuses to end a run while an arm has no verdict, and says how
  the run ends: done; a wait when an arm is pending; failed when an arm is
  unread, since an obligation nobody could read is not known to be settled.

### Core arms

The core arms are the classes M7 names for the post-merge stage, each
calling the skill that already owns the work: `do-item`'s post-merge status
rule and epic close, the deferral protocol, `file-issue`, `changelog`'s
status and tag plan, `change-areas`' post-deploy actions, `drive-pr`'s
driver listing. The skill holds the order and the verdicts, never a second
copy of those procedures, and every write goes through the tracker scripts
and `ghCall`, never a tracker's own tool, so the arms stay tracker neutral
and their calls governed.

Two rules matter most, because nothing else notices when they are missed:
an out-of-tree section that says "None" is
evidence while a missing section is not, and live verification is owed only
when the change has a runtime surface, reached a deployed environment (the
rollout, not the merge) and is not already covered by a CI check, and then
reports what the environment did rather than what it should do. The next
step is biased toward closure (finish a near-done epic, then operator work a
code change can clear, then batches of small items) and searches for an
existing container before it files anything.

### Authority is a fixed table

What the follow-up may do on its own, what it asks first, what a person
decides and what it never does is a table in the skill. A repository's
`followup.authority` may move an act to a stricter level and is refused when
it would loosen one, so no configuration lets a follow-up merge, act in
another repository or cross the origin-reference boundary. A step only a
person can take is reported as owed and filed, never a reason to stop; a
rate limit is a wait, never a question.

### Repository arms

What one repository owes after a merge and no other does (a promotion
ledger, a website, a status page) is a repository arm, declared in
`.config/jig.yaml` and settled under the same record-and-settle rules. An
arm comes in one of three forms:

- **An instructions file**, a prompt the agent carries out, read from the
  default branch so a pull request cannot rewrite the arm that follows it
  up.
- **A check command**, a script that prints a verdict JSON, runs without
  tracker or forge tokens and is bounded in time and output, the shape
  `do_item.preflight_command` already has.
- **A skill**, from the repository, the user's home or an installed plugin,
  named by its slash command and run by the same agent, which records its
  arm's verdict like any other.

Jig's own
follow-up becomes the plugin skill with Jig's website, status-page and
consumer arms declared this way.

## Left out

- **Draining a repository's ledger of out-of-tree work.** Recording what a
  merge owes is the follow-up's; executing a backlog of operations under
  batch approval is the repository's own procedure, in whatever form it
  supplies one.
- **A closure sweep of epics.** The follow-up calls `do-item`'s epic rule;
  an epic closes only on an accepted verdict or a waiver, and a sweep that
  moves an epic's tails is its own piece of work.
- **Running a pending arm again by itself on a run started by hand.** A
  dispatched run ends a pending arm as a wait (`waits --reason pending`),
  which the dispatcher starts again after its time; a run started by hand
  reports the pending arm, marks its marker done, and a person runs it
  again once the arm can settle.
