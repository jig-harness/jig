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
| **What** — the tracker | team-visible units of work: epics and sub-issues, with the mandatory taxonomy (type, status, flags) | until the work is done | the team; cross-session |
| **How** — persistent agent memory | the multi-session working knowledge for executing the *what*: the tactical plan, decisions made, gotchas discovered, where things are | across sessions, git-backed | the agents (and humans) working the item, now and next session |
| **In-session** — the ephemeral task list | the moment-to-moment checklist an agent keeps while doing one focused stretch of work | one session; discard on completion | the agent, right now |

A rule of thumb for which tier a note belongs in: *if it must outlive this
session, it is not in-session*; *if another agent or a human needs it, it is not
private*. Anything that clears both bars is a candidate for **promotion** (below).

### What — the tracker

The team-visible ledger. One epic or sub-issue per unit of work, each carrying
its taxonomy. This is the tier the [issue templates](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/ISSUE-TEMPLATES.md) and the
[label taxonomy](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml) govern. The tactical execution plan lives
*on the issue* precisely so it is not trapped in a session.

### How — persistent, multi-session agent memory

The working knowledge an agent accumulates while executing: what it tried, what
it decided, the shape of the code it is touching. Kept in a durable, git-backed
store (a `memory/` directory, or the agent runtime's memory feature — see
[M9's mappings](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/mappings.md)) so it survives a session ending and is there
when work resumes. This is *how* the work gets done, distinct from *what* the
work is.

### In-session — the ephemeral task list

The scratch checklist for one focused stretch (an agent's own todo list). It is
fine for it to be lossy: when the stretch is done, the durable outcome has
already been written up to the *what* or *how* tier, and the checklist is
discarded. Do not store anything here that has to survive.

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
   Groundwork's
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
