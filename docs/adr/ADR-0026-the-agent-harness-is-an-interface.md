---
title: "ADR-0026: The agent harness is an interface, and a session runtime is a separate one"
type: adr
status: draft
description: "The program that runs an AI model as an agent is reached through one agent-harness interface, with Claude Code and Codex as its first two implementations; where a session runs stays ADR-0011's session runtime, and the two vary independently"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-20
owner: maintainers
decision_date: 2026-11-20
supersedes: ~
superseded_by: ~
related:
  - docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md
  - docs/adr/ADR-0021-outbound-calls-are-governed.md
  - docs/adr/ADR-0012-failures-as-values.md
  - docs/adr/ADR-0013-records-not-a-daemon.md
tags: [adr, dispatcher, agents, harness, providers]
---

# ADR-0026: The agent harness is an interface, and a session runtime is a separate one

**Status:** Draft · **Date:** 2026-11-20 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig starts agent sessions: the [dispatcher](../../GLOSSARY.md) starts pickups,
drive passes, follow-ups and steward passes, and the skills start a drive and
its subagents. Each session runs an [agent harness](../../GLOSSARY.md), the
program that reads a prompt, calls tools and ends with a result. Two harnesses
are supported, Claude Code and Codex, and the choice between them is a
two-value type that runs through the code: the pass command is built by one
branch per value, the model names come from a table per value, the
environment a launch carries is stripped per value, and a skill's text is
written for the one that reads it first.

This holds only while the harness is one of two. A host that holds a key with
a model provider cannot have the dispatcher run on it. A team that wants to
try a third harness, such as [pi](../../design/provider-accounts.md#the-harness-trial),
would add a third value to every branch. What the dispatcher needs of a
harness is the same whichever it is, and it is small: the command that starts
a pass, the name a model has in that program, what the launch must carry and
must not, what the run cost, and how a stop is classified.

[ADR-0011](ADR-0011-the-dispatcher-targets-orca-first.md) already gives the
dispatcher one interface of this kind, the
[session runtime](../../GLOSSARY.md): the sessions in a repository's
workspaces, opening a workspace, launching a session on an account, notifying
a person. It answers *where a session runs*: Orca, or a plain process. It does
not answer *which agent program runs in it*, and the two vary independently. A
pi session can run in Orca or as a process; a Claude Code session can run in
either. Tying them together would make every new agent a new runtime.

## Decision

Jig reaches an agent program through one **agent-harness interface**. Claude
Code and Codex are its first two implementations. Code outside an
implementation names no harness by value: it holds a harness through the
interface, and the two-value type appears only inside the implementations and
the registry that lists them.

**The interface is its own record, not an amendment to ADR-0011.** The session
runtime is not widened: it keeps meaning where a session runs, and an
implementation of it asks a harness for the command to run, never the other
way around. A host's machine file chooses a runtime for the host; an account
chooses a harness.

An implementation provides these operations, each a function from facts the
caller holds to a value or an
[`Outcome`](ADR-0012-failures-as-values.md):

1. **`identify`**: its name and the versions of the program it can run.
2. **`passCommand`**: given a prompt, a working directory, a model, an effort,
   a permission mode, the stage's [harness profile](../../GLOSSARY.md) and the
   account, the command and environment that run one headless pass. A skill's
   invocation inside the prompt is a harness's own form
   (`/jig:drive-pr` or "use the `jig:drive-pr` skill").
3. **`interactiveCommand`**: the same for a session a person attaches to.
4. **`model`**: what a tier or a model identifier is called in this program,
   including a model outside the family list the configuration maps by name.
5. **`effort`**: the program's own level for an effort.
6. **`environment`**: what a launch on a given account carries and what it
   removes. A launch removes the vendors' credential variables and every
   provider key, whatever the letter case of a name; a provider account's launch carries that account's credential, which
   the host's secret command resolves, and no other.
7. **`usage`**: the tokens, the model and the cost the program reports at the
   end of a pass, read from its output or its transcript. This is what the
   [cost ledger](../../GLOSSARY.md) takes.
8. **`classifyStop`**: given an exit and its output, one of the closed
   [failure classes](../../GLOSSARY.md) or a plain failure, so a provider's
   refusal is read as the class it is and never as a subscription
   [wall](../../GLOSSARY.md).
9. **`transcript`**: where a session's transcript is and how to read it, for a
   closing report recovered from it.
10. **`capabilities`**: what the program has, as facts the callers check:
    background tasks, subagents, hooks, skills, permission modes, a structured
    question. A skill never branches on a harness's name; it branches on a
    capability.

A **third harness is added by writing one implementation and registering it**,
with nothing changed in the dispatcher, the arm script or the skills. A harness
that cannot supply an operation says so through `capabilities`, and a caller
that needs it refuses the launch with that reason.

**Skills get harness-neutral forms.** A skill's text refers to its own
directory and to the user through named forms the harness fills in: a
skill-directory substitution where a program offers no variable for it, and a
named fallback for the structured question (a numbered plain-text question
when the program has no tool for it). The forms are built with the interface,
not before it.

**Each stage has a harness profile.** The dispatcher runs a stage (drive-pr,
do-item, steward, ...) under a profile that is isolated from the host's own
configuration of that harness. A repository may add instructions, system-prompt
text and skills to a profile; an executable extension loads only from a
host-level allowlist. How a profile is built is in
[design/provider-accounts.md](../../design/provider-accounts.md#the-harness-profile-of-a-stage).

**A consumer subscription login never goes through a third-party harness.**
Which harness runs is the account's choice, and Jig's profile
for a third-party harness disables that program's login with a Claude Pro or
Max subscription. A Claude or Google consumer subscription login (Gemini CLI
or Antigravity OAuth) is never routed through pi or any other third-party
harness. An OpenAI subscription login is routed through a third-party harness only once
OpenAI's own wording allows it.

**A third harness is proven on one stage first.** pi is an opt-in third
harness, tried on drive-pr passes on one host's trial accounts. opencode is the
alternative if pi fails. Whether any third harness becomes a default is a
ruling a person makes from the trial's record; nothing here makes it one.

## Alternatives considered

- **Widen ADR-0011's session runtime to carry the harness.** Rejected: a
  runtime and a harness vary independently, and joining them multiplies the
  implementations (every harness for every runtime) and ties every new agent to
  every runtime.
- **A third value on the existing type.** The state before: each new harness is
  a change to every branch that tells Claude Code from Codex, and the branches
  drift. It also leaves the provider's failures to be read as a subscription's.
- **Run any other harness behind a Claude Code compatible endpoint.** A proxy
  that makes a provider look like Anthropic's API keeps one harness in the
  code and moves the differences into a process that each host runs and secures,
  as ADR-0021 and [ADR-0013](ADR-0013-records-not-a-daemon.md) decline to
  require for other systems.
- **Choose one harness and drop the second.** Teams hold subscriptions to both
  vendors' programs, and a harness's own features (its skill system,
  its permission modes) differ in ways a team picks by.

## Consequences

### Benefits

- A third harness, a new provider account or a changed command line is one
  implementation, not an edit through every call site.
- A provider's refusal is read by the program that knows its words, in one
  place, and arrives as a failure class.
- A skill that names a capability, not a program, runs on every harness that
  has it.

### Costs

- The existing call sites move behind the interface one pull request at a time,
  while the others keep their own branches.
- Each harness's usage output and refusal wording is an interface Jig depends
  on: a release of a program that changes them is work for Jig.
- Two layers now choose how a pass runs, the runtime and the harness, and a
  document that names a run says which one it means.

## Implementation

Built by [plan.md](../../design/plan.md) item 59, one pull request per step:
the interface with Claude Code and Codex behind it, and harness-neutral skill
forms; then pi as an opt-in third harness on one stage; then per-stage
profiles; then the ruling on a default harness from the trial. The design of
the accounts a harness runs under, the open model vocabulary and the
measurement is
[design/provider-accounts.md](../../design/provider-accounts.md).

## Extraction (decisions-become-checks)

Part of it is checkable once built: a gate that fails a branch on the two-value
agent type outside the harness implementations and their registry, a ratchet
over the call sites that predate the rule, and a contract test every
implementation passes. Until those arrive, review holds it, and
[ADR-0021](ADR-0021-outbound-calls-are-governed.md)'s integration lens asks
the provider obligations of any change to a launch. Whether a third-party
harness may receive a given login is not mechanically checkable beyond the
profile that disables the login and the test that reads it.
