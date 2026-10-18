---
name: review-reflections
description: "Review the findings sessions recorded with /jig:reflect: reconcile approved fixes with what merged, group the open findings by owner and class, propose a change, deferral, dismissal or escalation for each group, and after a person approves, make the changes in a pull request and record every decision. Use periodically, or when a class of finding keeps recurring."
argument-hint: "[--class <c>] [--target <t>] [--severity <s>] [--since <time>]"
allowed-tools: "Read Edit Write Grep Glob Bash(bun *) Bash(git *) Bash(gh *)"
---

# Review reflections

Sessions record what they learned about the scaffolding with
[`/jig:reflect`](../reflect/SKILL.md); the findings of every repository
accumulate in one shared store. This skill turns them into changes: it groups
what recurred, proposes a concrete change for each group, and **a person
approves every change before anything is edited**. The rules agents follow are
changing themselves here, which is human-in-the-loop by construction
([M8](https://github.com/jig-harness/jig/blob/main/modules/M8-learning-loop/README.md)).
How the records work is in [the reflect README](../reflect/README.md); this
skill's page for people is [README.md](README.md).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command.

Run every command from the root of the repository the changes would be made
in. In scope are the findings that repository would fix: those about its own
scaffolding, and, when it is a tool (it holds a plugin manifest, as Jig does),
every finding about that tool from every repository.

## 1. Reconcile

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/review.ts" reconcile
```

Each `approved` finding whose commit, or its pull request's merge commit, is
on the integration branch gets an `implemented` decision. `unverifiable`
lists findings whose check could not be completed (a commit this clone lacks,
a pull request that could not be read): they stay `approved`; report them,
never treat them as unmerged. Exit 3 (the integration branch could not be
fetched, or the store is unavailable) means nothing was reconciled: say so and
continue with step 2.

`{"on": false}` from any command means reflection is off: say so and stop.

## 2. Load

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/review.ts" load [--class <c>] [--target <t>] [--severity <s>] [--since <time>]
```

`groups` holds the open findings by owner, class and target, the most
recurrent first, each with its count, highest severity and findings (newest
first, with the session that recorded each). `awaiting_merge` and `deferred`
are for context. Pass the person's filters through.

Then read `notices`:

- `id-conflict`: a writer reused an id for different events. Show each
  copy's text and which one counts (the one whose text sorts first); it needs
  fixing in that writer, not here.
- `status-edited`: a person changed a status by hand where the store shows
  one. Show it beside its finding and ask the person to record it as a
  decision (step 6) or to put the shown status back.

`diagnose_error` set means the store's diagnosis failed: report it and go on
from the events.

## 3. Propose

For each group, read the files the findings name and propose one action:

| Action | When | What to write |
|--------|------|---------------|
| **Change** | The finding is right and a change would have prevented it | The concrete edit: which file, which section, the new text. Prefer a mechanical check (a gate, a script) over another instruction when the class recurred |
| **Defer** | Valid, not now | The reason and when to revisit |
| **Dismiss** | Not actionable, already fixed, or the current behaviour is intended | The reason, saying which |
| **Escalate** | The class recurs and needs a structural fix (step 5) | The class and its shape |

A finding about a Jig skill reviewed outside the Jig repository is not this
repository's to change: leave it for a review run in Jig. When Jig's
maintainers do not review the store this repository writes to, a review run
in Jig never sees it: with the person's approval, report it to Jig's
maintainers as an issue instead, with the finding's class and an example.

## 4. Approve

Present every proposal: the group (count, severity, an example title), the
proposed action and, for a change, the edit. The person approves, edits or
rejects each one. **Change nothing without approval.** In an unattended
session, stop here and report the proposals.

## 5. Escalate

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/review.ts" plan
```

lists the classes in scope at the escalation threshold (`file`: file one
issue with the repository's `issue_tracker.file_command`, labelled `label`,
with `owner_marker` as a line of its own in the description, linking any
`closed_issues`) or with an open issue already (`attach`).
`unverified` means the tracker could not be read, so an issue may already
exist: file nothing for that class and report it with `tracker`. After
the issue exists, and the person approved escalating:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/review.ts" escalate <class> <issue> [--owner tool:jig]
```

escalates every open or deferred finding of the class that the owner owns
(default: this repository; run in Jig, `--owner tool:jig` for Jig's skills).
An owner outside the review's scope is refused.

## 6. Implement and record

Make the approved changes in one pull request, following the repository's
pull-request policy as [`/jig:do-item`](../do-item/SKILL.md) does, then record
a decision per finding, one JSON object per line:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/review.ts" record --session '{"model":"<model id>"}' <<'EOF'
{"finding":"<id>","decision":"approved","reason":"<the change>","commit":"<sha>","pull_request":<n>}
{"finding":"<id>","decision":"deferred","reason":"<why, and when to revisit>"}
{"finding":"<id>","decision":"dismissed","reason":"<why>"}
EOF
```

`approved` records where the change is (commit and pull request); the next
review's reconcile turns it into `implemented` once it merges. A decision
about a finding the store does not hold, or one whose owner is outside the
review's scope, is refused.

## 7. Report

What was implemented, approved and awaiting merge, deferred, dismissed and
escalated, with the pull request and issue links, and what could not be
verified.
