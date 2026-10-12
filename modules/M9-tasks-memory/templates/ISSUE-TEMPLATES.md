# Issue templates — epic + sub-issue skeletons

Copyable skeletons for the two units of team-visible work: an **epic** (a
coordinating parent) and a **sub-issue** (a single deliverable). Both carry the
mandatory taxonomy from [`label-taxonomy.yaml`](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml) — a `type`,
a `status`, and zero or more `flags` — and both are tool-independent: paste them
into whatever tracker you use, or wire them as that tracker's issue template.

Two rules make these more than boilerplate:

- **The taxonomy fields are mandatory.** Every issue states its `type`, its
  `status`, and any `flags`. Flags are not decoration — each one *fires* a
  process (a `has-migration` flag fires the migration review; a `hitl` flag
  revokes autonomous merge). Leaving one off silently skips that process.
- **Epics and sub-issues link both ways.** An epic lists its sub-issues; each
  sub-issue names its parent epic. A reader landing on either can reach the
  whole picture without a search.

---

## Epic skeleton

```md
# EPIC: <one-line outcome, not a task>

- type: feature | bug | chore | spike
- status: triage | todo | in-progress | in-review | blocked | done
- flags: [<flag>, ...]        # e.g. [api-change] — each fires a process
- formula: <phase-formula name, if this epic follows one>

## Problem / outcome
<what changes for a user or the system when this epic is done, and why now>

## Success criteria
- [ ] <observable, checkable condition>
- [ ] <observable, checkable condition>

## Sub-issues
<!-- linked both ways: each child names this epic as its parent -->
- [ ] <ISSUE-KEY> — <sub-issue title>
- [ ] <ISSUE-KEY> — <sub-issue title>

## Out of scope
- <explicitly excluded, so scope creep is visible>
```

---

## Sub-issue skeleton

```md
# <imperative title: "Add ...", "Fix ...">

- type: feature | bug | chore | spike
- status: triage | todo | in-progress | in-review | blocked | done
- flags: [<flag>, ...]        # inherited from the epic + anything specific here
- epic: <EPIC-KEY>            # the parent — links back up

## Context
<the one or two sentences a fresh reader needs; link the epic and any ADR/PRD>

## Tactical execution plan
<!-- the small, ordered steps to land this — the "how", kept in the issue so it
     survives an agent session ending (see MEMORY-TIERS.md: this is the *what*
     tier; the moment-to-moment task list is ephemeral). -->
1. <step>
2. <step>
3. <step>

## Flags → process this issue must satisfy
<!-- restate what each flag fires, so the closer can check it happened -->
- <flag>: <the gate/review/checklist it fires>

## Acceptance
- [ ] <check> — including every required phase of the epic's formula, if any
- [ ] gates green; review threads resolved
```

---

## Filling the flags line

Each flag on an issue is a promise that a process ran. This table restates the
default triggers so a template user does not have to reopen the taxonomy.

| Flag | Fires |
|------|-------|
| `has-migration` | the migration review gate (mandatory before merge) |
| `api-change` | the contract / backward-compatibility gates |
| `security-sensitive` | a security review |
| `manual-ops` | an operator checklist that blocks `done` until complete |
| `docs-required` | a docs update that blocks `done` until complete |
| `hitl` | revokes autonomous execution/merge — a human must act |

Prune or extend this to match your own [`label-taxonomy.yaml`](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml);
the taxonomy file is the source of truth, this table is a convenience copy.
