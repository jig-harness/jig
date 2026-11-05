# Jig in the Orca ecosystem: design

**What problem this solves.** [Orca](https://www.onorca.dev) runs agent
sessions in [worktrees](../GLOSSARY.md) it manages, on a desktop or a
headless server a phone reaches, with subscription accounts, a workspace
board and scheduled automations. Jig's tooling already reaches it in
places built on their own: the
[Orca workspace tool](../tools/orca/README.md) behind the launcher,
`do-item`'s [board updates](../plugin/shared/orca-board.ts)
and workspace names, and the [dispatcher](../GLOSSARY.md)'s
[session runtime](../GLOSSARY.md), Orca first
([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)).
Of the rest of the execution line, the board, collection through Orca and
a plugin that wakes the dispatcher are built. What remains is the gap that
lets an agent start between collection's last check and the removal, the
dispatcher's reading of an account's usage from Orca's command line, and
what Orca 1.4.248 lets the plugin do beyond the wake-up: guard an agent's
launch, and show the line where a person works. With this built, Orca is
the runtime and Jig is the process: Orca owns workspaces, sessions,
accounts, the phone and the board; Jig owns what to start, when it is done
and what it still owes, and the two meet only through Orca's command line
and its plugin's events and hooks.

This is the design of [plan.md](plan.md) item 34. Herdr stays the
[workspace runtime](../GLOSSARY.md) Jig's tooling targets first
([ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md));
this design adds nothing a Herdr user loses. Collection goes through the
worktrees kind's runtime column, which a Herdr worktree joins by the same
route, and the board helper and the plugin are Orca-bound tooling with no
Herdr counterpart yet (Left out).

## How it works

The work falls in classes, built in this order: what Jig does on its own
side with Orca as it is, what Jig asks Orca to add, and a plugin Orca
loads. Each class pays off before the next starts.

### Where the two meet

| Orca surface | Jig today | What this design adds | Class |
| --- | --- | --- | --- |
| Worktree creation and agent launch, on this machine or a paired server | The launcher's `orca` provider and the workspace tool: the branch named as the repository names it, the M12 create hook run once, the agent started once per key | Nothing for a person; the dispatcher's launches reuse it (item 33) | use |
| The session registry, the account roster and the headless server | The dispatcher reads sessions, caps per account, notifies by comment and unread flag | Usage per account from the command line, which Orca shows in its desktop app and on the phone | contribute |
| The workspace board and comment | `do-item` names the card and moves it; `drive-pr` links the card to its pull request | Built: every stage moves the card: Ready, park, stop and merge | use |
| Setup and archive hooks | The workspace tool runs `.config/worktree-hooks/create` itself | Nothing yet: the plugin only logs a workspace created in the app; running the create hook once there waits on the dispatcher's open rules moving into the plugin ([dispatcher build step 3](dark-factory-dispatch.md#build-order)) | later |
| Worktree removal | `jig gc`'s worktrees kind collects an Orca-managed checkout through Orca, after the remove hook and the reflection park, and reports any other | The plugin's launch guard refuses a launch Orca makes into a worktree gc is collecting; a removal made in Orca's app runs the remove hook and the reflection park once Orca offers a hook before the removal | plugin, contribute |
| Scheduled automations | Nothing | Nothing: the dispatcher is a stateless tick on the machine's timer, with a report and a ledger, which an automation that runs an agent prompt is not | — |
| Orchestration runs: a coordinator, supervised workers, decision gates | `do-item` delegates to subagents in one session | A later design: the implementer as a supervised worker, routed by item 31 | later |
| Plugins: worker events, hooks, panels, status bar items, commands | A worker that wakes the dispatcher when an agent waits, blocks or finishes | The launch guard, an account binding through the same hook (a spike), a status bar item, the Jig panel, and a wake-up when a workspace is removed | plugin |
| Notifications and the phone | The dispatcher notifies a park once, as an unread card; the plugin shows each tick's receipt as an in-app notification | In the desktop app, the status bar's counts and overdue flag and the panel's inbox; on the phone, a push only when an agent needs input, which Orca sends for every finished turn today | plugin, contribute |

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

A card holds one comment, so a comment never replaces one a person has not
read: `--comment` reads the card's comment first and, while the card is
still unread, appends to it, as the dispatcher's notifications do
([dark-factory-dispatch.md](dark-factory-dispatch.md#notifications)); a
card that is not unread takes the comment as its new one. Orca's comment
write replaces the whole comment, so the read and the write of one card
happen under one lock, shared by the skills' helper and the dispatcher's
notifications and held across both; a writer that cannot take it within a
short deadline warns and skips, as every board call does on failure.

`plugin/shared/orca-board.ts` takes `--unread` and `--comment`, since
`do-item`, `drive-pr` and `followup` all call it. A repository with custom
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
checkout with an agent in any state short of finished (working, waiting or
blocked) is never idle, whatever git says, and an unreadable or incomplete
registry refuses collection, as the gc contract says (fail closed). The
registry is a snapshot, though: an opener can start an agent after the
read and before the removal.

The launch guard of Jig's plugin for Orca ([below](#the-jig-plugin-for-orca))
closes that race for every launch Orca makes. Orca runs the plugin's
`agent.launch.before` hook before it starts an agent's command from any of
its launchers: a new tab, a workspace's creation, Orca's command line, an
automation or an orchestration run. Before its last registry read, gc
takes its admission for the worktree in the guard record, a record Jig
writes and the hook reads without an awaited call; its format is defined
with the code that writes it. The hook refuses a launch into a worktree gc
holds, with the reason ("jig gc is removing this worktree"), and notes
every launch it lets through in the same record, so gc's re-read sees a
launch that passed just before the admission even before Orca's registry
lists it, and keeps that worktree. gc releases its admission on every
exit: once `orca worktree rm` returns, and when a proof, a teardown step or
the removal fails or throws. The admission names its owner by the
machine-wide holder record, and gc marks it submitted just before it calls
`orca worktree rm`. A gc that crashed before that mark leaves an admission
the hook and the next gc see is abandoned and ignore, while a live gc's
admission still excludes. One that crashed after the mark leaves a removal
Orca may still be carrying out, and owner liveness does not say whether it
has finished: the hook keeps refusing launches into that worktree while its
path exists, and the next gc reconciles it against the registry before it
releases the claim, clearing it once the worktree is gone and releasing it
once Orca lists the worktree intact with the removal settled. The hook decides before any awaited host call
and within Orca's 2 s deadline, since an awaited call ahead of its refusal
can fail or time out and let the launch through.

The guard fails open: a hook that throws, runs past its deadline or whose
worker is down lets the launch through, as Orca's default for a hook
(`onError` left at `pass`) does. A guard that failed closed would refuse
every agent launch in Orca, Jig's or not, whenever the plugin's worker
crashed. So gc treats the guard as best-effort protection, never as an
exclusion it can certify. A fresh heartbeat shows the worker was alive, not
that it is alive when `orca worktree rm` runs, and a single hook that throws
passes a launch while heartbeats continue; the registry and the
process-holder check stay gc's last checks either way. With a stale
heartbeat, or no plugin, gc collects as it does without the guard, and its
receipt says the collection was unguarded; with a fresh one the receipt says
guarded, meaning the launches the hook mediated.

What the guard does not cover: an agent a person types into a plain shell
in the worktree is not a launch Orca makes, and no hook sees it. gc's
process-holder check (`lsof`) still covers that case, since the shell
itself holds the worktree open. Orca does not hook a restore of a saved
session either; a restored agent is seen by the registry and the
process-holder check only once it runs, as before the guard. A removal a person makes in Orca's app is
not gc's either: it skips the remove hook and the reflection park until
Orca offers a hook before the removal ([the asks](#what-jig-asks-of-orca)).

The workspace tool's remove steps already run through Jig's own plugin
(`plugin/gc/worktree-removal.ts`). The `tools/orca` entry point stays
as the launcher's `orca` provider and the caller of the workspace-open
path until a pull request names the launcher's migration to the plugin;
that pull request deletes the copy.

### What Jig asks of Orca

What Jig needs is small, specific and absent from Orca's command
line and its plugin host. Each ask is filed as an issue in Orca's own style, with the pull request
offered in the issue; a person files it, since filing is outward-facing.

**Usage per account from the command line.** The dispatcher caps sessions
per subscription account and re-arms a drive stopped by one account's usage
limit on another. Orca shows each managed account's rate-limit windows and
reset times in its desktop app and on the phone, and its command line
lists accounts without them. The ask: `orca account usage --json`, one row
per managed account with its windows and resets, read from the snapshot the
app already keeps, fetched only with `--refresh`, and a row marked
`unavailable` for an account whose usage cannot be read rather than a
failed command. Each row carries a stable account identifier that the
dispatcher matches to the account in its machine file; a row it cannot
match is ignored. An `unavailable` row is never read as free: the account
takes no new launch and no re-arm until a later read succeeds, unless the
dispatcher holds a recorded wall for it, which then stands. Until the
command exists, the dispatcher reads usage walls from the drive ledger's
quota parks and from the waiting interactive sessions it probes
through the drive's quota adapters (`detectQuotaBlock`), which read the
vendor's session records under the account's configuration directory and
record the account's wall.

**A push only when an agent needs input.** The dispatcher notifies a park
once, as an unread card with the question as its comment, and Orca's phone
app pushes for every finished turn, so a park is one push among many. Orca
already tells `waiting` from `done`; the ask is a setting that pushes to
the phone for the first and not the second.

**A hook before a workspace's removal.** Orca sends `workspace.removed`
after the worktree's files are gone and has no hook before a removal, so a
removal a person makes in Orca's app skips the remove hook and the
reflection park that gc runs before its own `orca worktree rm`. The ask: a
`workspace.remove.before` hook, with the workspace's id, kind and path,
that can refuse the removal and has a deadline long enough for a
repository's remove hook, which the 2 s of Orca's other hooks is not.
Through it the plugin runs the remove hook and the reflection park, and
refuses the removal when either fails, as the workspace tool's `remove`
does. gc's own removal has already run both, so it marks the removal it
makes in the guard record, and the hook, finding the mark for that
worktree, skips the teardown and lets the removal through: each removal runs
its teardown once.

**Skills as a contribution point, when its format is defined.** Orca's
plugin manifest reserves `contributes.skills` and refuses a value in it.
When it opens, the `jig` plugin's skills are what Jig would contribute;
until then, the plugin below carries none. `contributes.hooks` opened in
Orca 1.4.248 as hooks on Orca's own actions, and the plugin's launch guard
is the first Jig contributes; running the M12 create hook from one waits as
the table above says.

### The `jig` plugin for Orca

A plugin Orca loads, in its own repository (Orca's directory lists a
plugin from a public repository with the manifest at its root, a version
tag and the `orca-plugin` topic, and refuses binaries), published as
`<repository owner>.jig`. Its worker is a Node process Orca starts with
the user's permissions. What this section adds to the wake-up needs Orca
1.4.248 or later, which brought plugin hooks and host API 1.3, and keeps
the worker of a plugin with hooks or status bar items running while the
plugin is enabled.

The plugin guards and shows; Jig decides and acts. The plugin reads records
Jig writes, writes to none but the guard record, runs the installed `jig`
command, and holds no rule of its own, so Jig's rules keep one release channel. Every act on the forge and on
a worktree stays Jig's, through the `orca` command line, which does more
than the plugin's host API: the host API has no worktree creation and no
comment write.

**Waking the dispatcher.** The worker is subscribed to
`agent.status.changed`, `workspace.created` and `workspace.removed`. On a
status change to `waiting`, `blocked` or `done`
in a repository with `.config/jig.yaml`, it runs `jig dispatch --apply
--repo <path>` for that repository, the invocation the timer makes, so the
machine file alone decides what a tick starts and the plugin passes no
flag a person reserves. It shows the tick's one-line receipt as an in-app
plugin notification, never as a phone push, since the plugin also ticks on
`done`: the outbound wake-up channel
[the dispatcher's design](dark-factory-dispatch.md) leaves for later,
without a change to the tick. Ticks for one repository run one at a time,
and a tick starts no sooner than a minute after the last one started. Every
event sets a pending flag and is counted before any invocation, whether it
starts a tick at once, arrives while a tick runs or arrives inside that
minute; a tick takes the count when it starts, and one trailing tick
starts once the running tick has finished and the minute has passed.
Once the tick has processed the repository, the plugin clears the pending
flag only if no event has arrived since that count, and otherwise keeps it
for the trailing tick. The tick lock is machine-wide, so a timer tick or
another repository's tick can refuse any invocation, the first one
included, without reading this repository: the plugin keeps the flag on a
refusal and retries after the same minute. While the worker lives, a status change after a tick read its
state is therefore never dropped, and the next tick that runs processes it,
later than a minute when a tick runs long or the lock is busy. The flag and
the count live in the worker's memory: a restart loses a pending tick, and
the machine's timer tick then processes the repository. On
`workspace.removed` of a worktree in a repository with `.config/jig.yaml`,
it wakes a tick for that repository the same way, so a launch whose
workspace a person removed ends at the next tick, not the next interval.
The worktree's folder is gone by then, so the plugin finds the repository
from what it recorded when it learned the workspace. On `workspace.created`
it logs the workspace and records its folder and repository, and starts
nothing. At startup the worker seeds the same record from Orca's existing
workspaces, so one created before the plugin was enabled or the worker
restarted resolves too; when a removed workspace still resolves to no
repository, the machine's timer tick processes it; the table above says when the create hook joins. One setting names the `jig` command; the plugin calls
the installed `jig` plugin and bundles nothing, so Jig's rules stay in Jig
and ship through Jig's own release channel.

**The launch guard.** The plugin contributes an `agent.launch.before` hook,
which refuses a launch into a worktree `jig gc` is collecting and lets
every other launch through ([Collection through the
runtime](#collection-through-the-runtime) says how gc and the hook share
the guard record, and what the guard does not cover). It decides from a
synchronous read of that record, never from a host call, and writes the
plugin's heartbeat into it while the worker runs. Its `contributes.hooks`
entry leaves `onError` at `pass`: a failed or absent guard lets a launch
through, and gc, seeing a stale heartbeat, collects unguarded and says so.

**An account for each launch, as a spike.** The dispatcher starts no
interactive pickup through Orca, since an Orca agent launch cannot pick
the subscription account it runs on
([dark-factory-dispatch.md](dark-factory-dispatch.md#admission-by-account)).
The launch hook can add environment variables to a launch. So the
dispatcher announces an interactive launch in the guard record with its
account, and the hook adds that account's configuration directory to the
launch's environment (`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME`
for Codex) and consumes the announcement. That the added variable wins
over Orca's own account selection is unproven, and the hook can add
variables but not remove an inherited credential that would bill another
account. A spike settles both for Claude Code and for Codex; until it
does, the binding stays off and pickups are reported, not started.

**The status bar.** A status bar item shows the newest tick's counts of
pull requests ready to merge and of needs waiting on a person, and flags
the tick as overdue when it is older than twice the dispatcher's interval.
The worker reads the line from a `jig` command that prints the newest
tick's line as JSON, as the dashboard serves it, so the plugin never opens
Jig's database. The flag catches a stopped timer while Orca runs; a host
that is off flags nothing, and telling a person about it needs a watcher
elsewhere. The item shows in the desktop app only.

**The Jig panel.** A panel in Orca's right sidebar, its icon in the
sidebar's activity bar. A panel draws either as a web page in an isolated
frame (`ui: "html"`) or as Orca's own controls (`ui: "components"`). A
spike on fixture data, shot in light and dark, picks the drawing mode and
finds what fits the sidebar's width before the first view is built. A
panel has no network: it asks its worker through `plugin.request` (host
API 1.2), and the worker runs `jig` as the person. The panel stores
nothing, and has these views:

- **Inbox**, where it opens: everything waiting on the person across the
  machine file's repositories, read from the newest tick's line. That is
  parks with their decisions and reply drafts, stalled pickups, double
  claims and, once the dispatch board's Ready to merge is built, the merge
  queue. Each entry links its pull request and opens the Orca workspace
  that holds the work (`workspace.open`, host API 1.3).
- **Board**, the dispatch board's columns
  ([dispatch-board.md](dispatch-board.md)), once the board places every
  card. A merge-now card carries a merge button: a person's click runs the
  drive's pinned merge command, exactly as the line gives it and only after
  it passes the command's strict forms, as that person and nothing else.
  A panel has no network route, so the button opens no write route into
  the host, which is why the dashboard keeps link and copy only.
- **Addresses**, each address with recent activity, such as a drive's or
  a follow-up's, and its thread oldest first: the request, the question,
  the answer and the outcome, each linked to the record it came from. The
  thread comes from `jig ask <address> --thread`, and an answer typed in
  the inbox or a thread goes out through `jig send <address> answer`, once
  both commands exist.

Every thread the panel shows is records `jig ask` reads, and every reply it
sends is a record `jig send` writes, so an address reads the same on the
command line, on the forge and in Orca. The panel never types into a live
agent's terminal; it opens the workspace instead. The dashboard stays
`jig dispatch dashboard` for every other reader, the phone among them,
since whether Orca's phone app shows plugin panels is not verified.

## Build order

One pull request each, in this order; each is usable on its own.

1. **This design** and its plan item.
2. **The board from Jig's side** (built), after `drive-pr` links the card
   to its pull request: `orca-board.ts` into `plugin/shared/` with `--unread` and
   `--comment`, the moves in `drive-pr` and `followup`, `orca.board`.
3. **Collection through the runtime** (built; step 6 closes its race): the worktrees kind's runtime column,
   the `orca.command` machine entry, the remove steps moved into the
   plugin, the registry in the proof, tests against a fake `orca` command;
   collection is enabled, and an agent started after the registry read can
   still race the removal until the launch guard is built.
4. **The asks**, filed by a person, each with its pull request to Orca
   when a maintainer does not take it.
5. **The plugin's wake-up** (built, in
   [its own repository](https://github.com/jig-harness/orca-plugin); the
   listing is open): the manifest, the worker, validation in its own CI.
6. **The launch guard.** In Jig, the guard record: gc's admission taken
   before its last registry read and released after the removal, a launch
   noted after the admission keeping the worktree, the heartbeat's
   freshness, and a receipt that says guarded or unguarded. Then, in the
   plugin, the `agent.launch.before` hook that reads the record and refuses
   or notes the launch, the heartbeat, the wake-up on `workspace.removed`,
   and `engines.orca` raised to 1.4.248.
7. **The account binding spike**, after step 6: whether a variable the hook adds
   binds a launch to the dispatcher's chosen account for Claude Code and
   for Codex. Only if it does, the dispatcher announces each interactive
   launch in the guard record and starts pickups through Orca.
8. **The status bar item**, after `jig` prints the newest tick's line as
   JSON.
9. **The Jig panel.** First the spike on fixtures that picks the drawing
   mode and the sidebar's fit, then the inbox, then the Board view after
   the dispatch board places every card, then the Addresses view after
   `jig ask --thread` and `jig send` exist. Each view is its own pull
   request.

## Left out

- **The plugin's worker as the dispatcher's timer.** The worker stays
  running while the plugin is enabled and could tick on a clock of its
  own. The machine's timer stays instead: when Orca is closed, nothing in
  it ticks, and a headless host needs the machine's timer anyway.
- **Orca's automations as the dispatcher's timer.** An automation runs an
  agent on a prompt; the tick is a program that must run with no agent and
  leave a receipt.
- **A tick on a merge.** Orca has no pull request, git or branch event, so
  the plugin cannot wake the dispatcher when a pull request merges; the
  machine's timer catches the merge at its next interval.
- **Acts through the host API.** The plugin never launches an agent, sends
  to a terminal or reads one through Orca's host API. The `orca` command
  line already does all of that and more (the host API creates no worktree
  and writes no comment), and acts in the plugin would split Jig's rules
  across two release channels.
- **Orchestration runs as `do-item`'s delegation runtime.** Running the
  implementer as a supervised Orca worker, routed by item 31, changes how
  `do-item` delegates and waits on Orca's own loop settling; it is a design
  of its own after item 33 and item 31.
- **A Herdr counterpart of each part.** The board and the plugin have no
  Herdr equivalent today; the collection step's runtime column is where a
  Herdr worktree would be collected through `herdr worktree remove` when
  that is built.
