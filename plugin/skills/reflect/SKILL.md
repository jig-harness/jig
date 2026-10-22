---
name: reflect
description: "Record what this session learned about the repository's scaffolding (instructions, skills, gates, reviewer configuration): gather the worktree's journal, merge duplicates, name each finding's class, escalate a recurring class to one tracker issue, and contribute the rest to the shared reflection store. Use at a natural end: a converged drive, an addressed review, the end of a session, before a worktree is removed."
argument-hint: "[--quick | --comprehensive]"
allowed-tools: "Read Grep Glob Bash(bun *) Bash(git *)"
---

# Reflect

An agent session often learns something about the scaffolding it worked in:
an instruction that misled it, a skill step that failed, a gate that let a
known problem through, a convention it had to rediscover. Unless the lesson is
written down somewhere durable and someone later acts on it, the next session
learns it again. This skill writes it down: each session records its findings,
the findings of every session and repository accumulate in one shared store,
and [`/jig:review-reflections`](../review-reflections/SKILL.md) later turns them
into changes a person approves. It is the session-reflection cycle of
[M8 (learning loop)](https://github.com/jig-harness/jig/blob/main/modules/M8-learning-loop/README.md).

How the records work (the event log, the journal, the store contract and its
stores) is described for people in [README.md](README.md). This file is the
procedure.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command.

Run every command from the root of the repository the session worked in.
Never `cd` into the skill directory.

## 0. Is reflection on?

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reflect.ts" status
```

`{"on": false}` means no configuration layer has a `reflection` section (or it
says `enabled: false`). Say so in one line, with how to turn it on (a
`reflection:` section in `~/.jig/jig.yaml`, see the plugin's
[configuration reference](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#reflection)),
and stop. Do not write findings anywhere else.

## 1. Gather

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reflect.ts" gather [--mode <mode>]
```

Pass `--mode comprehensive` when this skill was invoked with
`--comprehensive`, `--mode quick` when with `--quick`, and no `--mode`
otherwise. The output holds the journal's unsent findings (including any a
removed worktree of this repository left pending, which it adopts), the
classes the store already uses with how many findings each has, and the mode
(the one passed, else `reflection.mode`, else `quick`). A
`store_error` means the store could not be read: carry on; the findings stay
in the journal if contributing fails too.

Then add what the session itself observed and the journal does not hold yet.
Ask yourself, and in an attended session the person:

- **Quick mode:** what went wrong or cost time? Which instruction, skill step,
  gate or reviewer setting caused it or failed to prevent it?
- **Comprehensive mode, in addition:** what worked well and should be kept,
  what could work better, and which skill outputs needed several iterations.

Save each finding as `<finding.json>`, then note it:

```bash
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --stdin-file <finding.json> -- bun "${CLAUDE_SKILL_DIR}/scripts/journal.ts" note
```

A finding is one JSON object:

| Field | What to write |
|-------|---------------|
| `kind` | `error` (something went wrong or cost time), `opportunity` (something could work better) or `unhelpful-content` (instruction text that cost context without helping) |
| `severity` | `high`, `medium` or `low`; for an opportunity or unhelpful content, its priority |
| `class` | A kebab-case name for the failure *shape*, not the incident (step 3) |
| `target` | `{"scope":"repository","name":"<file or area>"}` for this repository's own scaffolding; `{"scope":"tool","tool":"jig","name":"<skill>"}` for a Jig skill |
| `title` | One line: what happened |
| `description` | What happened and why it cost something |
| `suggested_fix` | The concrete change that would have prevented it, naming the file |
| `time_cost_minutes` | Optional: the time it cost |
| `change` | Optional: `{"pull_request": <n>, "issue": "<key>"}` when the script could not tell |
| `session` | What you know and a script cannot read: `{"model": "<model id>", "skills": ["<skills used>"]}`. Never guess a value; leave it out |

Keep only what is about the **scaffolding**, not the product, and is
**actionable**. A product bug is not a reflection finding.

## 2. Merge

Two journal entries about **the same incident** (a skill noted it, and you
noted it again) become one. Keep the earliest and drop the others into it:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/journal.ts" drop <id> --reason "same incident" --merged-into <earliest-id>
```

Two incidents of the same problem stay two findings: each is evidence of
recurrence. Save revised fields such as `class` and `severity` as
`<revision.json>` and revise a finding instead of noting it again:

```bash
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --stdin-file <revision.json> -- bun "${CLAUDE_SKILL_DIR}/scripts/journal.ts" revise <id>
```

## 3. Name the class

Reuse a class from `gather`'s `classes` whenever its shape fits (its example
title shows the shape). After a successful `gather`, `classes` is every class
the store holds, never a ranked or capped search result, so a class missing
from it does not exist: check the whole list before you coin a name. With a
`store_error`, `classes` is `null` and shows nothing about which classes
exist: a name you coin then may duplicate one the store holds, so say in the
finding's description that the store could not be read. Findings of one class are counted together, so two
names for one shape hide a recurrence. A new class needs a name that
describes the shape (`instruction-missing-precondition`,
`narrow-fix-per-round`), and its finding's description says the shape in one
sentence. A finding a skill captured with a placeholder class (the review
loop's `review-took-many-rounds`) gets the class of the gap it points at.

## 4. Decide what to contribute

Drop what is not about the scaffolding or not actionable, with the reason:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/journal.ts" drop <id> --reason "<why>"
```

An open finding of the same class and target already in the store does not
keep a new one out: it is another occurrence.

**Attended session:** show the person the list (title, class, target,
severity, suggested fix) and let them edit or drop before anything is stored.
**Unattended** (a drive's pass): proceed; the review is where a person
filters.

## 5. Escalate or file

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reflect.ts" plan
```

For each class this repository owns among the findings to contribute, the plan
gives the class's recurrence count (with the new findings), its tracker issue
and the action:

| `action` | Do |
|----------|----|
| `attach` | Pass `--issue <class>=<open_issue>` to step 6 |
| `file` | File one issue for the class's structural fix with the repository's `issue_tracker.file_command` (ask the person when none is configured), labelled with `label`, with `owner_marker` as a line of its own in the description (the lookup attaches only to issues carrying it), describing the shape and linking the `closed_issues` if any (the class recurred after their fix). Then pass `--issue <class>=<new key>` |
| `store` | Nothing: the findings are stored as they are |
| `unverified` | Due for escalation, but the tracker could not be read, so an issue may already exist: do not file. Store the findings as they are and report the class and `tracker` to the person |

A finding about a shared tool (`scope: tool`) is never escalated here: it is
escalated by `/jig:review-reflections` run in that tool's repository. When
`tracker` reports no tracker, report the classes due for escalation to the
person instead of filing.

## 6. Store

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/reflect.ts" contribute [--issue "<class>=<issue>"]... --session '{"model":"<model id>"}'
```

It appends the unsent findings, and an `escalated` decision for every open
finding of each `--issue` class, in one write, marks the findings contributed
in the journal, and comments on each issue when the tracker can. Exit 3 means
the store is unavailable: the findings stay in the journal for the next run;
say so, it is not an error to work around.

## 7. Report

One short block: what was stored (with the store's references), what was
escalated to which issue, what was dropped and why, and what stays in the
journal. Under a drive, record the reflection with
the `set-reflected` operation of `drive-state.ts` as `/jig:drive-pr` describes.

## Rules

- Never edit the store or the journal by hand; use the scripts.
- Never store a finding about the product, a person, or anything private to
  the session.
- Never change scaffolding from here: changes go through
  `/jig:review-reflections` and a person's approval.
