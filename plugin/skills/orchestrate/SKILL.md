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
The brief names the input, the required return, and the durable record to
update. Wait for that return; do not perform the delegated work in the
coordinating session. This rule applies to every delegation below.

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
AskUserQuestion), otherwise a plain-text numbered question. With nobody
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
running the command from the consumer repository's root. If the identity or
procedure cannot be determined, file verified work but ask the person how to
start it; do not improvise.

### 7. File the defects

Send defects to a separate session using `/jig:file-issue`, with instructions
to verify each against the code and search for duplicates before filing. The
filing session uses `/jig:file-issue`'s tracker operations and the procedure
established in step 6. Separating it keeps verification and tracker mechanics
out of the person's discussion.

Start the important defects, with the person's approval, through the
work-start mechanism and identity established in step 6, even when they sit
outside the agreed topic's first wave. Record which defects were started and
which remain filed.

### 8. Prepare the delivery and request approval

When the agreed work spans more than one pull request, have a fresh session
write the plan on the repository and host's review surface. Only the first
wave becomes tasks; give later waves one line each, so unstarted detail does
not become stale. State a default for each unanswered choice in the plan;
when the person approves it with a choice unanswered, say that its stated
default settles that choice. Request review on that surface, tell the person,
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

After approval, send the first wave to a fresh filing session using
`/jig:file-issue`. Each issue carries the decisions in its body: its pickup
session sees nothing else. Start the issues through the dispatcher, using
the configured mechanism and identity established in step 6.
Where the host has no dispatcher, use its configured work-start procedure
(a single issue's pickup belongs to `/jig:do-item`); if none is configured,
ask the person how to start the filed issues. Record what actually started.

### 11. Pick up the state on every return

Each time the person returns, read the state of started work through
`/jig:operator` in a fresh session when the `jig` command is available.
Otherwise, query the configured tracker or delivery mechanism read-only and
mark unavailable evidence explicitly. Bring any parked question back with a
recommendation, so the next discussion rests on the current work rather than
this session's earlier picture.

### 12. Keep a durable record

At every change of state, update the tracks, decisions, issue numbers and
what is owed in the repository or host's existing durable record facility,
so a later session can resume. Delegate its maintenance to a separate
session. With no such facility, use a plain file outside the repository;
with no writable persistent facility, give the person the complete record
to save and supply on return, and state that it has not been persisted.

### 13. Demote without losing what was learned

When the person lowers a track's priority, send its removal to the plan
keeper when there is one, and retain its facts in a note marked as an idea in
the durable record. A one-deliverable handoff updates that record directly.
A demotion changes what is owed without discarding useful evidence.

### 14. Date every figure

Every survey figure carries its date and how it was counted, and the filing
session re-measures it before putting it in an issue. Live counts change
between surveys, so an old count must not become a new issue's premise.

Keep reports short and lead with what changed. Use one decision per numbered
line, without file dumps, so the person can see what needs their answer.
