# Jig in the Orca ecosystem: design

**What problem this solves.** [Orca](https://www.onorca.dev) runs agent
sessions in [worktrees](../GLOSSARY.md) it manages, on a desktop or a
headless server a phone reaches, with subscription accounts, a workspace
board and scheduled automations. Jig's tooling already reaches it in three
places, each built on its own: the
[Orca workspace tool](../tools/orca/README.md) behind the launcher,
`do-item`'s [board updates](../plugin/skills/do-item/scripts/orca-board.ts)
and workspace names, and the [dispatcher](../GLOSSARY.md)'s
[session runtime](../GLOSSARY.md), Orca first
([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)).
Nothing says how the rest of the execution line meets Orca: a parked drive
leaves its card where it was, `jig gc` cannot collect an Orca-managed
worktree without leaving Orca's card and terminals behind, the dispatcher
cannot read an account's usage from Orca's command line, and Orca's plugin
system has no Jig in it. With this built, Orca is the runtime and Jig is the
process: Orca owns workspaces, sessions, accounts, the phone and the board;
Jig owns what to start, when it is done and what it still owes, and the two
meet only through Orca's command line and its plugin events.

This is the design of [plan.md](plan.md) item 34. Herdr stays the
[workspace runtime](../GLOSSARY.md) Jig's tooling targets first
([ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md));
this design adds nothing a Herdr user loses, and each part names what a
second runtime implements to have the same.

## How it works

The work falls in three classes, built in this order: what Jig does on its
own side with Orca as it is, what Jig asks Orca to add, and a plugin Orca
loads. Each class pays off before the next starts.

### Where the two meet

| Orca surface | Jig today | What this design adds | Class |
| --- | --- | --- | --- |
| Worktree creation and agent launch, on this machine or a paired server | The launcher's `orca` provider and the workspace tool: the branch named as the repository names it, the M12 create hook run once, the agent started once per key | Nothing for a person; the dispatcher's launches reuse it (item 33) | use |
| The session registry, the account roster and the headless server | The dispatcher reads sessions, caps per account, notifies by comment and unread flag | Usage per account from the command line, which Orca shows in its desktop app only | contribute |
| The workspace board and comment | `do-item` names the card and moves it; `drive-pr` links the card to its pull request | Every stage moves the card: Ready, park, stop and merge | use |
| Setup and archive hooks | The workspace tool runs `.config/worktree-hooks/create` itself | A plugin event runs it once for a workspace created in the app | plugin |
| Worktree removal | `jig gc`'s worktrees kind reads plain git and is disabled | An Orca-managed worktree is collected through Orca, after the remove hook and the reflection park | use |
| Scheduled automations | Nothing | Nothing: the dispatcher is a stateless tick on the machine's timer, with a report and a ledger, which an automation that runs an agent prompt is not | — |
| Orchestration runs: a coordinator, supervised workers, decision gates | `do-item` delegates to subagents in one session | A later design: the implementer as a supervised worker, routed by item 31 | later |
| Plugins: worker events, panels, commands | Nothing | A worker-only plugin that wakes the dispatcher on an agent's status change | plugin |
| Notifications and the phone | The dispatcher notifies a park once, as an unread card | A push only when an agent needs input, which Orca sends for every finished turn today | contribute |

### The board, from Jig's side

Orca's board is a convenience: the skills call it only in a terminal Orca
opened, every failure warns and the exit is 0, as `orca-board.ts` does
today. What changes is that every stage of the execution line moves the
card, so the board tells the truth without anyone dragging a card:

- `do-item` moves the card to `in-progress` at pickup and `in-review` when
  it opens the pull request (built);
- `drive-pr` marks a Ready pull request's card `in-review`, and a park, a
  usage-limit stop and a failure stop mark the card unread with the stop's
  one-line reason as the comment, so the phone shows what needs a person;
- `followup` moves the card to `completed` after the merge, with the
  release the merge still owes as the comment.

`orca-board.ts` gains `--unread` and `--comment` and moves to
`plugin/shared/`, since three skills call it. A repository with custom
board columns maps the stages onto them in `orca.board` in `.config/jig.yaml`
([CONFIGURATION.md](../plugin/CONFIGURATION.md)). Jig moves the card
itself rather than asking Orca to follow the pull request's state: Jig
knows the stage before the forge shows it, so the card is right sooner than
a poll would make it.

### Collection through the runtime

`jig gc`'s worktrees kind ([design/resource-gc.md](resource-gc.md)) tells
an Orca-managed checkout from a plain one: when the machine entry names
Orca's command (`orca.command`, since the scheduler's run is not inside an
Orca terminal and `plugin/shared/orca.ts` resolves the command from the
environment only), the inventory reads `orca worktree list --json` for the
repository and marks each checkout's runtime. An Orca-managed checkout is
collected the way the workspace tool's `remove` does it today: the remove
hook inside the worktree, the reflection park, then `orca worktree rm`,
never `git worktree remove`, so the card, the terminals and the agent
records go with the checkout. Orca's registry is part of the idle proof: a
checkout whose agent Orca reports working is never idle, whatever git says,
and an unreadable registry refuses collection, as the gc contract says
(fail closed). The workspace tool's remove steps move into the plugin for
this, as item 33 moves its open steps, and the `tools/orca` copy is
deleted in the same pull request.

### What Jig asks of Orca

Two things Jig needs are small, specific and absent from Orca's command
line. Each is filed as an issue in Orca's own style, with the pull request
offered in the issue; a person files it, since filing is outward-facing.

**Usage per account from the command line.** The dispatcher caps sessions
per subscription account and re-arms a drive stopped by one account's usage
limit on another. Orca shows each managed account's rate-limit windows and
reset times in its desktop app and on the phone, and its command line
lists accounts without them. The ask: `orca account usage --json`, one row
per managed account with its windows and resets, read from the snapshot the
app already keeps, fetched only with `--refresh`, and a row marked
`unavailable` for an account whose usage cannot be read rather than a
failed command. Until it exists, the dispatcher reads usage walls from the
drive ledger, as `drive-pr`'s quota adapters do.

**A push only when an agent needs input.** The dispatcher notifies a park
once, as an unread card with the question as its comment, and Orca's phone
app pushes for every finished turn, so a park is one push among many. Orca
already tells `waiting` from `done`; the ask is a setting that pushes to
the phone for the first and not the second.

**Two contribution points, when their format is defined.** Orca's plugin
manifest reserves `contributes.skills` and `contributes.hooks` and refuses
a value in either. When they open, the `jig` plugin's skills and the M12
hooks are what Jig would contribute; until then, the plugin below carries
neither.

### The `jig` plugin for Orca

A plugin Orca loads, in its own repository (Orca's directory lists a
plugin from a public repository with the manifest at its root, a version
tag and the `orca-plugin` topic, and refuses binaries), published as
`<repository owner>.jig`. It is a worker only: a Node process Orca starts
with the user's permissions, subscribed to `agent.status.changed` and
`workspace.created`. On a status change to `waiting`, `blocked` or `done`
in a repository with `.config/jig.yaml`, it runs one `jig dispatch` tick
for that repository, at most one a minute per repository, and shows the
tick's one-line receipt as a notification: the outbound wake-up channel
[the dispatcher's design](dark-factory-dispatch.md) leaves for later,
without a change to the tick. On `workspace.created` it logs the
workspace; the create hook joins once the workspace tool's rules are in the
plugin (the collection step above). One setting names the `jig` command;
the plugin calls the installed `jig` plugin and bundles nothing, so Jig's
rules stay in Jig and ship through Jig's own release channel.

It has no panel. A panel is sandboxed HTML with no network and no channel
to the worker yet, so a live dashboard in Orca would show nothing; the
dashboard stays `jig dispatch dashboard`, opened as an HTML tab.

## Build order

One pull request each, in this order; each is usable on its own.

1. **This design** and its plan item.
2. **The board from Jig's side**, after `drive-pr` links the card to its
   pull request: `orca-board.ts` into `plugin/shared/` with `--unread` and
   `--comment`, the moves in `drive-pr` and `followup`, `orca.board`.
3. **Collection through the runtime**: the worktrees kind's runtime column,
   the `orca.command` machine entry, the remove steps moved into the
   plugin, the registry in the proof, tests against a fake `orca` command.
4. **The two asks**, filed by a person, each with its pull request to Orca
   when a maintainer does not take it.
5. **The plugin**, after item 33's tick exists: the manifest, the worker,
   validation in its own CI, the listing.

## Left out

- **Orca's automations as the dispatcher's timer.** An automation runs an
  agent on a prompt; the tick is a program that must run with no agent and
  leave a receipt. The machine's timer stays.
- **A panel in Orca.** Until a panel can receive data from its worker, it
  would be a static page; the HTML dashboard already exists.
- **Orchestration runs as `do-item`'s delegation runtime.** Running the
  implementer as a supervised Orca worker, routed by item 31, changes how
  `do-item` delegates and waits on Orca's own loop settling; it is a design
  of its own after item 33 and item 31.
- **A Herdr counterpart of each part.** The board and the plugin have no
  Herdr equivalent today; the collection step's runtime column is where a
  Herdr worktree would be collected through `herdr worktree remove` when
  that is built.
