---
name: orchestrate
description: "A large, loosely bounded topic with no single work item: recorded decisions, a reviewed plan and started issues. Not for one work item (do-item), one decision (decide), explaining how something works (explain), or commanding stations (operator)."
argument-hint: "<topic>"
allowed-tools: "Read Grep Glob Task AskUserQuestion Bash(bun *)"
---

# Orchestrate

Keep the person's thinking and decisions in one session; send investigation,
recording and delivery to fresh sessions and the
[line](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).
The result is decisions recorded, a plan reviewed and issues started.
The coordinating session never implements, edits repository files, commits, pushes or merges.
It reads almost no files itself: a targeted lookup of a known file is fine;
wider investigation belongs in a fresh session so it cannot crowd out the
discussion. Use the sibling skills below rather than repeat their mechanics.

A **track** is one related strand of the topic; a **survey** is its read-only
investigation; a **plan keeper** is the separate session maintaining the plan.
These terms and this session's distinction from an operator or steward are in
the [glossary](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).

When a step calls for a fresh or separate session and the runtime cannot
start one, prepare a concise brief for the person to run in a separate session.
The brief names the input, the required return, and the repository record
to update, if any. Wait for that return; do not perform the delegated work in the
coordinating session. This rule applies to every delegation below.

## The notebook

Each topic keeps its record in an **orchestration notebook**: a folder on
this host at `$JIG_HOME/orchestrate/<topic>/` (`~/.jig/orchestrate/<topic>/`
by default), outside every repository's working tree and never committed.
Every agent tool reads and writes it the same way; it belongs to no agent's
profile or memory facility. It holds:

- **`state.md`**, the current state: rewritten whole at every change of state,
  and kept to about 150 lines. Each of its sections is required, with "None."
  under one that is empty:
  - `## Focus`: the tracks and where each stands, with demoted tracks
    marked as ideas (step 13);
  - `## Waiting on the person`: each decision, numbered, with its
    recommendation;
  - `## Owed`: each act this session owes, with its due date;
  - `## Running`: the delegated work in flight, and when it started;
  - `## Cautions`: what was learned that a successor must not relearn;
  - `## Next act`: the first thing a successor does;
  - `## Links`: the issues, plans, pull requests and decision records the
    topic touches, linked and never copied.
- **`journal/YYYY-MM-DD.md`**, one file a day (UTC), only ever appended to:
  each decision, ruling and action, with its reason. Read it only when a
  question needs the history, never in full at start.

The notebook replaces no repository record: decision records, the plan and
the tracker stay where they are, and `state.md` links to them.

Reach it through its script only, from the repository root, with the topic
as the person gave it; the script names the folder, so "Release cadence" and
`release-cadence` are one topic. `state` and `journal` read the text from
standard input (a quoted here-document in a POSIX shell; in PowerShell a
here-string piped in, after `$OutputEncoding = [Text.UTF8Encoding]::new()` so
the text arrives as UTF-8):

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/notebook.ts" open "<topic>"
bun "${CLAUDE_SKILL_DIR}/scripts/notebook.ts" state "<topic>"
bun "${CLAUDE_SKILL_DIR}/scripts/notebook.ts" journal "<topic>"
bun "${CLAUDE_SKILL_DIR}/scripts/notebook.ts" list
```

`open` creates a new topic's folder and prints the folder, the resume prompt
for each agent tool, the journal's days and `state.md`. `state` replaces
`state.md` whole and refuses (exit `3`, nothing written) a state missing a
section; past 150 lines it writes and warns, and the next rewrite moves the
history to the journal; on that refusal, add the missing section and run it
again. `journal` appends one timestamped entry to today's file. `list` names
each topic with when its state was written. Every command refuses (exit `4`)
a notebook whose resolved destination lies inside a Git working tree, whether
`JIG_HOME` lies in one or a symbolic link on the way (the `orchestrate`
folder, the topic folder, `journal` or a day's file) leads into one; exit `1` is a folder or file that
could not be read or written. On exit `4` or `1`, use step 12's fallback.

When each part is written:

1. **On start**, before step 1, run `open`. When it prints a state, resume
   from it alone: bring back `## Waiting on the person` with its
   recommendations, then take `## Next act`, and go on at the step the state
   shows; read no other record to resume. When it reports a new topic, run
   `list`, and if a listed topic looks like the one meant, ask the person
   which it is before writing to either.
2. **At natural pauses** (a decision recorded, an issue started, delegated
   work returned, the person leaving), append what happened and why to the
   journal, then rewrite `state.md`.
3. **At handover** (step 15), rewrite `state.md` last: it is the record the
   successor resumes from.

## Procedure

### 1. Split into tracks

Separate the input into tracks, and give a first take on each, explicitly
marked as given before the facts are in. This keeps an initial opinion from
being mistaken for a finding.

### 2. Survey every track at once

Start one read-only survey per track, all at the same time, in fresh sessions
using the harness's sub-session facility. If that facility is unavailable,
give the person the briefs to run in separate sessions and wait for their
returns; do not replace fresh context with broad reads in this session.
Each brief states the goal and why it is asked, asks numbered questions,
and tells the survey to report what exists rather than argue for the idea.
Ask for existing positions in decision records and designs with their binding
sentences quoted, and evidence against the idea. Forbid edits and writes.
Fix the return: a word limit, one table, a "what I could not determine"
section, inference marked as inference, and no file cited unless opened.
Ask about the live host only where the facts are cheap and read-only to get.
This makes independently gathered evidence comparable without advocacy.

### 3. Report as each survey returns

Give a short note containing only findings that change the picture.
Hold decisions until every survey has returned, so early results do not
decide a question later evidence could change.

### 4. Consolidate

Explain how the tracks relate, then give one decision per numbered line,
each with a recommendation so the person can answer by number. List defects
found along the way separately: repairing a defect is distinct from agreeing
the topic's direction. Send a technical dilemma to a fresh session using
`/jig:decide`; send a system question needing a sourced explanation to a
fresh session using `/jig:explain`. Those sessions own any generated records;
this session receives their findings.
Ask through the runtime's question tool where available (Claude Code:
AskUserQuestion), otherwise a plain-text numbered question (one numbered line per option, the recommended one first and marked as the default where there is one, which the reply `default` takes: ask one question per turn; when a batch is unavoidable, every reply names the question number and then the option number or `default`, as `2.1` or `2.default`, or the question number and free text, as `2: keep both formats`; a reply of `default` to a question with no marked default, a question the reply leaves out and one it explicitly defers stay unanswered until the person clarifies; a question it answers twice with incompatible answers, in either reply form or mixed (`2.2` beside `2.default`, `2.1` beside `2: keep both formats`, or two different free-text replies), is a conflict, kept distinct from an omission and from an explicit deferral: no plan default settles it, and only the person's explicit resolution does). After emitting a single question or a batch, end the turn and resume from the person's reply. With nobody
there to answer, stop and state the question rather than choose for them.

### 5. Record each answer

Record each answer in the durable record, including what remains unanswered,
so a later session can distinguish an agreement from a recommendation.
Send an architectural answer to a fresh session using `/jig:adr` when it
qualifies for a decision record. If the person disputes a cited rule, open
the rule itself before answering: a survey's summary is not the rule.

### 6. Prepare filing and work starts

Before filing defects or agreed work, determine the configured work-start
mechanism and, on a dispatcher host, its factory identity. Do this even when
the surveys found no defects: the agreed work may still need to be filed and
started. Read the identity through the shared configuration reader; never
invent an identity or start command:

```bash
bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" dispatch.identity --json
```

`${CLAUDE_SKILL_DIR}` means the directory holding this file. Claude Code
fills it in; another harness substitutes the installed absolute path before
running the command from the consumer repository's root. That command reads
layered local configuration, while a dispatcher send reads the tracker,
identity and dispatch states from the forge's default branch. Record the
values the send will use (read from the default branch where you can); where
they cannot be verified, or differ from the local read, record them as
unverified, and treat any start as one the pickup thread cannot settle. If the
identity or procedure cannot be determined, file verified work but ask the
person how to start it; do not improvise.

### 7. File the defects

Send defects to a separate session using `/jig:file-issue`, with instructions
to verify each against the code and search for duplicates before filing. The
filing session uses `/jig:file-issue`'s tracker operations and the procedure
established in step 6. Separating it keeps verification and tracker mechanics
out of the person's discussion.

Start the important defects, with the person's approval, through the
work-start mechanism and identity established in step 6, even when they sit
outside the agreed topic's first wave. Record each attempt before sending it
and classify its result by the rules of step 10, then record which defects
started and which remain filed.

### 8. Prepare the delivery and request approval

When the agreed work spans more than one pull request, have a fresh session
write the plan on the repository and host's review surface. Only the first
wave becomes tasks; give later waves one line each, so unstarted detail does
not become stale. State a default for each choice the person left out in the plan;
when the person approves it with such a choice unanswered, say that its stated
default settles that choice, except a choice the person explicitly deferred,
their replies conflict on, or answered in a way step 4 needed clarified (an
invalid reply stays its own state, never an omission), which waits for their
explicit resolution. Hold back each task that depends on such a choice and
hand off only the independently approved work. Request review on that surface, tell the person,
and end the turn; never poll for review. Without a configured review
surface, present the plan in chat for explicit review and end the turn.

When the agreed work is one deliverable, do not create or hand off a plan.
Instead, state the proposed issue and work-start handoff in the durable record
or chat, request the person's explicit approval, and end the turn. In either
case, an unanswered choice or missing approval is not permission to start
work.

### 9. Hand an approved multi-pull-request plan to a plan keeper

Only for approved work that spans more than one pull request, send the
answers, issue numbers and demotions to one separate plan-keeper session.
This keeps plan mechanics out of the coordinating session. A one-deliverable
handoff has no plan keeper.

### 10. File and start approved tasks

After approval, send the eligible tasks of the first wave (those step 8
did not hold back) to a fresh filing session using `/jig:file-issue`. Each issue carries the decisions in its body: its pickup
session sees nothing else. Start the issues through the dispatcher, using
the configured mechanism and identity established in step 6.
Where the host has no dispatcher, use its configured work-start procedure
(a single issue's pickup belongs to `/jig:do-item`); if none is configured,
ask the person how to start the filed issues. Record what actually started, and each held task with the decision that
blocks it. Track filing and starting separately: when a task is filed but
not started (the work-start procedure was unknown, or a launch failed), reuse
its recorded issue key. Before sending a start, record
the issue key, the time, and the settings the send resolves (the tracker
target, the identity and the dispatch states). Classify each start's result three ways. A **confirmed success** is
the mechanism's own terminal success for that attempt (the dispatcher send
read back the expected assignee and reported `sent`, or a configured
work-start procedure returned its own success receipt): record it and wait
for pickup. A **verified rejection made before
anything was written** is a failed start: record the reason. Anything else
(a refused result whose confirmation read threw, a timeout, or a recorded
attempt with no saved outcome, as after a crash) is **unconfirmed**: it may
still be in flight, so never resend it on a guess. Settle it only by the
mechanism's own terminal answer for that attempt: a launch record or receipt
tied to that attempt, or the work-start procedure's status read. An
issue-level assignment record does not identify an attempt (it carries no
time, and another trusted writer's assignment looks the same), so it is not
confirmation; a current pickup shows only that work is already underway. A
state someone set by hand, an earlier launch of the same issue, or a missing
entry in a thread is not evidence either way. A direct read of the item's
assignee, state and assignment history is allowed to diagnose partial effects
(an assignment outside the dispatch states, a state change without its
assignment), but its absence or ambiguity is inconclusive, never a reason to
retry. Resend only when the mechanism gives a terminal answer that the
attempt did not land, or accepts a retry keyed to the same attempt; when it
can give neither, leave the start unresolved, say so, and ask the person.
Verified evidence of a pickup underway now for this work (not an earlier
launch that ended or failed) stops any resend while who caused it stays
unknown: record it as "started, attribution unknown", and keep the send
attempt's own attribution unresolved.
Wait
when pickup is pending (it happens on a later tick). When an accepted pickup
claimed the item and then stalled, follow the recovery the status reports, or
surface the blocker, keeping the issue key. When the assignment landed but the issue is still outside the
configured dispatch states, do not repeat the send (it is refused): name the
state transition needed and ask for it through the authorized recovery path.
When a held task's decision arrives, file and start only the
newly eligible remainder, never a task already filed. Send the plan keeper
(step 9, when the plan has one) each decision when it is recorded, including
a rejection that leaves no task to hand off, and each issue key as soon as
filing succeeds, whatever the launch outcome. Write each such update into the
notebook as owed before sending it, and clear it only once the keeper confirms
it applied it. On every return, reconcile the owed updates against the plan
the keeper holds before repeating or clearing any (a keeper may have applied
one whose acknowledgment was lost).

### 11. Pick up the state on every return

Each time the person returns, recheck any start still unconfirmed against
the source of the mechanism that sent the request: a dispatcher start through
the operator's pickup thread read for that issue (the ordinary status can
report a claim from tracker membership alone), any other work-start
procedure through its own receipt or status read. Read it with the settings
recorded for the attempt in step 10, never the current checkout's or a
later configuration's. The pickup thread read resolves the tracker from the
current checkout, so when the adapter, team, identity or states may differ
from the recorded ones and the match cannot be established, leave the result
unresolved instead of trusting that read. Treat every recorded attempt with
no saved outcome as unconfirmed: check it and record where it stands before
resending that item or starting work that depends on it; independent approved
work is not held by it. An unreadable source or inconclusive answer keeps the
start unconfirmed, holds the work that depends on it, and is never a reason
to retry; recording the result does not release dependents. Then read the
state of started work through
`/jig:operator` in a fresh session when the `jig` command is available.
Otherwise, query the configured tracker or delivery mechanism read-only and
mark unavailable evidence explicitly. Bring any parked question back with a
recommendation, so the next discussion rests on the current work rather than
this session's earlier picture.

### 12. Keep a durable record

At every change of state, update the [notebook](#the-notebook) so a later
session can resume: the tracks, decisions, issue numbers and what is owed.
This session writes the notebook itself, since it holds the state and the
notebook is no repository file; the repository's own records (decision
records, the plan, the tracker) are kept by the fresh sessions above and
linked from `state.md`. Wherever this procedure says "durable record", it
means the notebook, which only this session writes: a brief to a fresh
session names the repository record it updates, never the notebook.
Where the notebook cannot be written, use a
plain file outside the repository with the same sections; with no writable
persistent facility, give the person the complete record to save and supply
on return, and state that it has not been persisted.

### 13. Demote without losing what was learned

When the person lowers a track's priority, send its removal to the plan
keeper when there is one, and retain its facts in a note marked as an idea in
the durable record. A one-deliverable handoff updates that record directly.
A demotion changes what is owed without discarding useful evidence.

### 14. Date every figure

Every survey figure carries its date and how it was counted, and the filing
session re-measures it before putting it in an issue. Live counts change
between surveys, so an old count must not become a new issue's premise.

### 15. Hand over before the context fills

A coordinating session that runs until its context is full loses state to
[compaction](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the runtime replacing the earlier
conversation with a shorter summary) or a forced restart, and with it a decision or an owed act.
Watch for the signs of a long session: the person has returned many times,
many delegated results have been read, decisions have been carried across
hours. At a natural pause, with no delegated work about to return and no
question half-asked, suggest a handover to the person rather than wait for
the context to fill. Hand over only with their agreement, never silently.

Once the person agrees:

1. Append the handover to the journal and rewrite `state.md` (step 12), so
   it holds the current state, each decision with its date, what waits on
   the person, the acts this session still owes, the cautions learned, and
   a first act for the successor under `## Next act`.
2. Start the successor through the host's session facility, opened in the
   surface the person works in (prefer the one this session runs in, such as
   a chat view rather than a terminal), as a new session given the resume
   prompt `open` printed for its agent tool (`/jig:orchestrate <topic>` in
   Claude Code). The topic alone points at the record: the successor's start
   reads the notebook, which stays the single source of the state, so the
   prompt cannot drift from it. Where the host has no such facility, give
   the person the exact command to run, the runtime's agent command with
   that prompt, and wait for them to say it started. Where step 12 could
   persist no notebook, give the successor a directive that points at the
   record step 12 kept instead, or tell the person to give it the record
   they saved.
3. After a minute or so, confirm the successor is alive: it is listed and
   its session is live, or, where the person started it, they say it is
   still running. If it is gone, start it again (or give the person the
   command again) with the resume prompt and a line saying its first act
   may be partly done, so it checks before repeating it, and repeat this
   confirmation after every replacement. Where liveness cannot be established, a
   successor may still be running, so this session keeps ownership but stays
   quiescent (it sends no commands, launches nothing and updates no record)
   and tells the person; it resumes work, or goes on to step 4, only once
   the person confirms the successor is stopped or running. Do not go on to
   step 4 before then.
4. Only once a successor is confirmed alive, tell the person it now holds
   the topic. This session then stops acting: it sends no further commands and launches nothing, so two
   sessions never act on the same line at once.

## Reporting

Keep reports short and lead with what changed. Use one decision per numbered
line, without file dumps, so the person can see what needs their answer.
