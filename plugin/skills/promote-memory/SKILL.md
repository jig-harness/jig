---
name: promote-memory
description: "Promote a durable lesson from an agent's private memory into the team's git-tracked docs, after checking it still holds; use when a memory has become knowledge the whole team should share."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# Promote memory

Lift an agent-private memory into the team's git-tracked docs. This is the
[memory promotion](https://github.com/docomply/jig/blob/main/GLOSSARY.md) step of Jig's learning loop
([M8](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/README.md); its
[flywheel template](https://github.com/docomply/jig/blob/main/modules/M8-learning-loop/templates/FLYWHEEL.md),
§ Companion cycle: memory promotion), between the memory tiers that
[M9](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/MEMORY-TIERS.md) defines. The
promoted page lands in the docs tree that Jig's docs-as-wiki governance module
([M4](https://github.com/docomply/jig/blob/main/modules/M4-docs-governance/README.md)) lays out.

## Context

A repository that works this way runs two knowledge systems side by side:

1. **Agent-private memory.** In Claude Code this is
   `~/.claude/projects/<project-slug>/memory/`: a `MEMORY.md` index and topic
   files (`project_*.md`, `feedback_*.md`, `user_*.md`), each with a `type:`
   in its frontmatter. The slug is derived from the checkout path, so a
   session in a worktree may see a different directory. Claude Code maintains
   it; it is never committed. Other agent tools keep their private memory
   elsewhere: use the location your tool documents. It holds per-session
   decisions, the user's preferences and project context.
2. **The team's docs.** The git-tracked docs tree (`docs/` unless the
   repository names another root), governed by the repository's wiki schema
   (M4's [`WIKI-SCHEMA.md`](https://github.com/docomply/jig/blob/main/modules/M4-docs-governance/templates/WIKI-SCHEMA.md)
   template, adapted). Authoritative for the team.

By default, session lessons stay in the private layer, so private
conversations and half-formed ideas do not leak into git. This skill is the
explicit promotion when a memory crosses the threshold into team knowledge.
Promotion is a review point, not an automatic copy: a wrong lesson promoted
becomes everyone's wrong lesson.

## When to use

**Promote a memory when all of the following are true:**

- The insight is durable, not just the current session's task.
- Other team members, human or agent, would benefit from finding it.
- It contains no personal data, no user-specific preferences and no
  half-formed speculation.
- It does not duplicate existing docs (check first, step 2).

**Do not promote:**

- `feedback` memories about the user's preferences (they stay private).
- `user` memories about the user's role or context (they stay private).
- Notes from an investigation still in progress (let them mature in memory
  first).
- Anything that belongs in a decision record, an issue or a commit message
  instead.

## When not to use

If the memory describes an **architectural decision**, use
`/jig:adr` to write an architecture decision record
([ADR](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) instead. A decision record carries more weight
than a retrospection page and goes through review. This skill is for
observations and lessons, not decisions.

If the memory describes a **bug** or a **feature**, file it in the
repository's issue tracker (the command in `issue_tracker.file_command` in
`.config/jig.yaml`, when set).

## Repository values

Read these from `.config/jig.yaml` when present; each has a
default:

- `promote_memory.lint_command`: a command that checks one memory against the
  repository, with `{dir}` and `{file}` standing for the memory directory and
  the memory's file name: the repository's own memory lint, if it has one,
  for example `<memory-lint command> --dir {dir} --file {file}`. Exit 0 means
  clean; anything else means stop. Default: none, and step 1b is done by hand.
- `promote_memory.target_dir`: where promoted pages go. Default:
  `docs/retrospection` (the raw-sources layer of M4's three-layer model).

The activity log is the wiki's `log.md` in the docs root (M4's layout), if the
repository keeps one.

## Workflow

### 1. Identify the source

Ask the user, or infer from context, which memory file:

```text
Source: ~/.claude/projects/<project-slug>/memory/<file>.md
```

Read the file. Check its `type:` frontmatter: only `project` memories are
promotable by default. `user` and `feedback` memories need the user's explicit
override.

### 1b. Check the memory still holds (blocking)

A memory that no longer describes the repository must not be promoted: the
docs would republish the stale claim under a team-visible path.

**With `promote_memory.lint_command` set**, run it with `{dir}` and `{file}`
filled in.

- **Exit 0**: continue.
- **Any other exit**: **stop. Do not promote.** Show the user the findings.
  A memory lint reports only and never edits the memory, so the way forward is
  the user's to choose: recheck each named path or symbol against the
  repository, reword or drop the stale ones, record `verified_at` (below), and
  run it again.

Read a stale-path finding before rewording, though: a lint cannot always tell
a renamed path from one that belongs to another repository, or from a path
relative to a skill's own directory. A finding names something to recheck,
not proof the memory is wrong; and a clean run does not vouch for the
memory's claims.

**Without a lint command**, do the same checks by hand: every repository path
the memory names is still tracked (`git ls-files --error-unmatch <path>`) and
still present in the checkout (`test -e <path>`: the index still lists a file
whose deletion is not yet staged), every symbol it names is still
in the file it names, and the memory carries a valid `verified_at`. Any
failure stops the promotion the same way.

Either way:

- The memory must carry `verified_at: YYYY-MM-DD @ <commit>` in its
  frontmatter: the day, and the short commit hash of the checkout, on which
  someone last confirmed its claims about the repository still hold. It is
  recorded only after checking; touching a memory without rechecking must not
  change it. A memory without one is unverified and is not promoted until it
  has one.
- A memory that names a path only to say it was removed reads as stale too:
  reword it rather than override the check. There is no bypass, on purpose.
- A memory carrying `retracted:` in its frontmatter is never promotable: a
  withdrawn lesson must not be republished. If the retraction was itself a
  mistake, the user removes the field by hand and the memory is verified again
  first.

These checks answer whether the memory's references resolve and whether it is
dated, not whether it is true. Whether it is true remains the promoter's
judgment and the pull request review's.

### 2. Check for duplicates

Before writing anything, search the docs for the memory's core terms:

```bash
grep -ril "<key-term>" docs/ --include="*.md"
```

If an existing page already covers the topic, **update that page** instead of
creating a new one. Set its `last_updated` to today's date in Coordinated Universal Time and point to the
updated section from the activity log.

### 3. Transform

Convert the memory into a retrospection page. Use the repository's wiki schema
for the frontmatter vocabulary (the values for `type`, `status`, `lifecycle`,
`owner` and `tags` come from its frontmatter schema); with M4's schema it
looks like this:

```markdown
---
title: "Retrospection: <short description>"
type: retrospection
status: active
lifecycle: temporary
last_updated: YYYY-MM-DD
owner: <owner from the schema>
description: "<one-line summary>"
source_memory: <sanitized-memory-name>.md   # see "Private names" below
derived_from:            # entries copied from the memory; omit the key if the memory has none
  - <memory slug | issue key | pull request number | doc path>
verified_at: YYYY-MM-DD @ <commit>   # copied verbatim from the memory (step 1b guarantees it is set)
tags:
  - <topic-tag>
---
```

**Private names.** The privacy rule for the body (no personal data, no
private conversation details) applies to every value that reaches the
repository, not only the body: `source_memory`, the `<slug>` in the target
path (step 4) and the activity-log entry (step 5). A memory's file name can
carry a person's name, a customer or a private project. Check each such value
before writing it; when it fails, use a neutral, topic-only name instead (for
example `retry-backoff-lesson`) for `source_memory` and derive `<slug>` from
the page's sanitized title, never from the memory's file name.

`derived_from` and `verified_at` are the memory's provenance: what it rests on,
and when its claims were last checked. Carry them over exactly as the memory
has them: `derived_from` is the memory's list written one entry per line, with
no entry added, dropped or reworded. Do not refresh `verified_at` to today:
promoting a memory is not rechecking it, and a promoted page that claims a
newer check than anyone performed hides exactly the staleness this field
exists to expose.

Provenance is checked by the same privacy rule but never rewritten: a renamed
`derived_from` entry no longer points at what the claim rests on. If any entry
fails the check (for example a memory slug that carries a person's or a
customer's name), stop the promotion for this memory and report which entry
blocked it. The owner can rename the source first, or leave the memory
unpromoted.

Then the page body:

```markdown
## Context
What was being worked on and why. Remove any personal data or private
conversation details.

## Key Findings
The durable insight worth capturing.

## Implications
How this should shape future work.

## Related
- Links to decision records, feature docs, or other retrospection pages
```

### 4. Place the file

Target path: `<target_dir>/YYYY/MM/YYYY-MM-DD-<slug>.md`, where `<slug>` is the
sanitized, topic-only name from step 3 ("Private names"). Create the dated
subfolders if they do not exist.

### 5. Update the activity log

If the repository keeps an activity log, add an entry at the top under
today's date:

```markdown
**[Promotion] <slug>**
- Source: agent memory `<sanitized-memory-name>.md`
- Target: `<path of the new page, relative to the docs root>`
- Rationale: <one line>
```

### 6. Consider a connection page

If the promoted page links three or more document categories, propose
creating or extending a cross-domain page (`connections/` in M4's layout). Do
not create one automatically: suggest it to the user.

### 7. Do not modify the source memory

Leave the original memory file in place. Memory accumulates; promotion only
adds. Change the memory file only if the user explicitly asks to remove the
promoted content.

## Governance

- This skill only promotes. Removing content from the docs (demotion) needs a
  separate review.
- The promoted page is `status: active` and `lifecycle: temporary` by default.
  A later session, or the repository's wiki lint, may promote it further into
  a permanent page (a decision record, a feature document) as it matures.
- Never commit the promotion automatically. The user reviews the diff and
  commits it.

## Related skills

- `/jig:adr`: use instead when the memory describes an architectural
  decision.
- `/jig:descar`: the de-scarring pass a page gets before it is
  promoted to a permanent, approved document.
- The repository's wiki lint, if it has one: it reports retrospection pages
  that were never promoted further (the retrospection backlog in M4's lint
  table).
