# Memory tiers — what / how / in-session

A note-to-self in a chat window is gone when the session ends. A task list that
lives only in an agent's head does not survive a crash, let alone reach the next
agent. This template names the three tiers where work-in-progress and knowledge
live, what belongs in each, and — the part that is easy to skip — how a durable
lesson gets **promoted** out of one agent's private memory into shared,
git-tracked memory the whole team (human and agent) can rely on.

The point of separating the tiers is that each has a different lifetime and a
different audience. Putting the wrong thing in the wrong tier is how knowledge
either evaporates (a lasting decision left in an ephemeral task list) or clutters
(a throwaway step promoted into permanent docs).

## The three tiers

| Tier | Holds | Lifetime | Audience |
|------|-------|----------|----------|
| **What** — the tracker | team-visible units of work (epics and sub-issues, with the mandatory taxonomy) and everything another session needs about one of them: the tactical plan, decisions with their reasons, handoffs | until the work is done | the team: any session, worktree, tool or person |
| **How** — persistent agent memory | durable knowledge about the codebase and its tooling, not about one work item: gotchas, where things are, what a command really does | across sessions; private first, then promoted into git-tracked docs | the agent, then the team once promoted |
| **In-session** — the task list and worktree scratch | the moment-to-moment checklist for one focused stretch, and scratch files kept in a gitignored directory of the worktree | one session, or the worktree | this session, later sessions in the same worktree, and the person operating that worktree |

A rule of thumb for which tier a note belongs in: *if it must outlive this
session, it is not in the task list*; *if a different worktree, or a person not
working in this one, needs it, it is not in worktree scratch*: it goes on the tracker item. A lesson
about the codebase that clears both bars is a candidate for **promotion**
(below).

The boundary that is easiest to misjudge is worktree scratch. It survives the
session, so it feels durable, but only a session in that same worktree sees
it, whichever agent runtime it uses: a sibling worktree, another clone or a
colleague's machine never does. A note parked there is invisible to the
reader most likely to need it.

There is no fourth tier. Work state has exactly one authoritative store, the
tracker, whatever it is built on: a hosted tracker, or a plan file kept in
the repository and read through the same tracker interface. A second store
beside it (a task database next to a hosted tracker, say) restates what the
tracker already holds, drifts from it, and leaves two records that disagree.
Agent memory holds knowledge about the code, not work state.

### What — the tracker

The team-visible ledger. One epic or sub-issue per unit of work, each carrying
its taxonomy. This is the tier the [issue templates](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/ISSUE-TEMPLATES.md) and the
[label taxonomy](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml) govern. The tactical execution plan, the
decisions taken on the item and every handoff live *on the issue*, precisely
so they are not trapped in a session or a worktree.

### How — persistent, multi-session agent memory

The knowledge an agent accumulates about the codebase while working: the shape
of the code, the traps it hit, what a command really does. It is about the
code, not about one work item, so it outlives any single item. It starts in
the agent runtime's memory feature, private to the agent, and the durable parts
are promoted into git-tracked shared docs (see
[M9's mappings](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/mappings.md)). This is *how* the work gets done, distinct from
*what* the work is.

### In-session — the task list and worktree scratch

The scratch checklist for one focused stretch (an agent's own todo list), and
any scratch files the work needs, kept in a gitignored directory of the
worktree. It is fine for both to be lossy: when the stretch is done, the
durable outcome has already been written up to the *what* or *how* tier.
Nothing that another worktree, or a person not working in this one, must
read stays here.

One worktree often holds more than one agent at a time: a session a person
operates, the unattended loops it starts, the subagents it delegates to.
They all see the same scratch directory, so it is where they pass working
files to each other: a brief for a subagent, a loop's resumption file, a
[control channel](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
into a running loop. These rules keep that sharing safe. Each file has one
writer, or is an append-only log whose every append takes a lock, so two
agents never overwrite each other. And a file's name says what it belongs
to (the pull request or item), so a later session can tell what is stale.
Jig's skills keep theirs in `.context/` at the root of the worktree, which
the repository gitignores.

## The machine-local store

Agents in different worktrees of one machine still share things: a lock
that runs heavy test suites one at a time, a lease saying which session
owns a pull request's review, a review loop's per-round records, the brief
an orchestrating session prepares for the agents it starts in other
worktrees. None of these fits a tier. The tracker is the wrong place for a
lock or a thousand-line brief bundle; worktree scratch is invisible to the
sibling worktrees that need them.

They go in a **machine-local store**: a folder outside every worktree, one
per clone, at a path the user can move (by default a state directory such
as `~/.local/state/<tool>/<clone>/`, overridden by an environment
variable). Every worktree of that clone on that machine reads it; no other
machine and no person away from it does.

It is not a fourth tier, because it must hold no work state the tracker lacks.
A tool keeps its own working state there, and anything a decision, a plan or
a handoff depends on is published on the tracker item first, so what the
store holds is a working copy. The test is to imagine the folder deleted
tonight:

- if only a tool would have to rebuild or restart (a lock is re-taken, a
  brief is regenerated from the tracker items, a review loop starts its
  next round from the pull request), the machine-local store is the right
  place;
- if a person, or a session on another machine, would lose something they
  need (a plan, a decision and its reason, where the work stopped), it
  belongs on the tracker item, and at most a copy goes in the store.

A tool can fail this test without meaning to. A review loop that records
which findings it parked for a person, and why, only in its store keeps a
decision there: deleting the folder re-opens that work. Until the tool
publishes such a record where the work lives (a comment on the pull
request) or can rebuild it from there, treat that file as more than a
working copy and do not delete it.

A sibling worktree's scratch directory is never a machine-local store,
however convenient: it is removed with that worktree, and it belongs to the
agents working there.

## Handoffs

A handoff is the note one session leaves so another can carry on. When the
next session may run in a different worktree or as a different person, the
handoff goes on the tracker item as a comment, never in worktree scratch. It says what is done, what remains, what was decided and
what is uncertain, and ends with the command that resumes the work:

```md
**Done** — what is finished, with evidence (commits, pull requests, check runs)
**Remaining** — what is left, in priority order
**Decisions** — what was decided, and why
**Uncertain** — what is unknown or untested

Resume: <the command or first step the next session runs>
```

Link to what already exists instead of restating it, and never paste a secret.

A tool may also keep a resumption file in worktree scratch for the next session
in the *same* worktree, such as a review loop's per-round notes or the token
of the item it picked up. That file is a local working copy, not the handoff:
whatever a different worktree or a person away from this one needs from it is
published on the tracker item or the pull request.

## Memory promotion — private → shared

Persistent agent memory starts **private**: one agent's per-session notes. A
lesson only becomes reliable for everyone once it is **promoted** into
git-tracked, shared memory through a review point — never an automatic dump.

```
private memory            promoted (proposed)          git-tracked shared memory
(one agent, this  ─────▶  a candidate lesson      ─────▶  reviewed + merged;
 session's notes)         surfaced for review              every agent sees it
```

1. **Capture** — an agent records a durable lesson in its private memory during
   work ("this service's client must be closed explicitly", "the staging seed
   omits X").
2. **Propose** — a promotion step (a `/promote-memory`-style command, such as
   Jig's
   [`promote-memory`](https://github.com/docomply/jig/blob/main/plugin/skills/promote-memory/SKILL.md)
   skill) surfaces the lesson as a *candidate* for shared memory, rather than
   editing shared memory silently.
3. **Review** — a human (or a review point) accepts, edits, or rejects it.
   Promotion is [HITL](https://github.com/docomply/jig/blob/main/GLOSSARY.md) by construction: it changes the
   shared record the whole team trusts.
4. **Land** — the accepted lesson is committed to git-tracked shared memory,
   where it reaches other agents and survives indefinitely — and becomes fodder
   for retrospection.

This is the same **memory-promotion** cycle described in
[M8 — Learning loop](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop), which pairs it with session
**reflection**. M9 owns the *tiers* (where memory lives); M8 owns the
*promotion and reflection loop* (how a lesson is proposed, reviewed, and turned
into durable improvement). Adopt them together: the tiers give reflection a
place to write, and reflection gives the tiers their discipline.
